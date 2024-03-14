import { CustomResource, Duration, RemovalPolicy, StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { BastionHostLinux, ISecurityGroup, InstanceClass, InstanceSize, InstanceType, Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Architecture, Code, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { BundlingOptions, NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, LogGroupProps, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, DatabaseInstanceProps, PostgresEngineVersion } from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";
import { ApiDefinition, ApiMetadata, NamedMetadata } from "typizator";
import { ConnectedResources, PING } from "typizator-handler";
import { Provider } from "aws-cdk-lib/custom-resources";
import { readFileSync } from "fs";
import { CronOptions, Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";

export interface ExtendedStackProps extends StackProps {
    deployFor: string
}

export type LambdaProperties = {
    nodejsFunctionProps?: Partial<NodejsFunctionProps>,
    logGroupProps?: LogGroupProps,
    extraBundling?: Partial<BundlingOptions>,
    extraLayers?: LayerVersion[],
    schedules?: [{
        cron: CronOptions,
        eventBody?: string
    }]
}
export type LambdaPropertiesTree<T extends ApiDefinition> = {
    [K in keyof T]?:
    T[K] extends ApiDefinition ?
    LambdaPropertiesTree<T[K]> :
    LambdaProperties
}

export type TSApiProperties<T extends ApiDefinition> = {
    deployFor: string,
    apiName: string,
    description: string,
    apiMetadata: ApiMetadata<T>,
    lambdaPath: string,
    lambdaProps?: NodejsFunctionProps,
    logGroupProps?: LogGroupProps,
    sharedLayerPath?: string,
    extraLayers?: LayerVersion[],
    extraBundling?: Partial<BundlingOptions>,
    lambdaPropertiesTree?: LambdaPropertiesTree<T>,
    apiExclusions?: string[]
}

export type TSApiPlainProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: false
}

export type TSApiDatabaseProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: true,
    migrationLambda?: string,
    migrationLambdaPath?: string,
    dbProps: Partial<Omit<DatabaseInstanceProps, "databaseName">> & { databaseName: string },
    bastion?: {
        openTo: string[] & { 0: string }
    }
}

const camelToKebab = (src: string | String) => src.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
const kebabToCamel = (src: string | String) => src.replace(/(?:_|-| |\b)(\w)/g, (_, p1) => p1.toUpperCase())

const DEFAULT_SEARCH_DEPTH = 8

const requireHereAndUp: any = (path: string, level = 0) => {
    try {
        return require(path)
    } catch (e) {
        if (level > DEFAULT_SEARCH_DEPTH) throw new Error(`Handler not found, searching up to ${path}`)
        return requireHereAndUp(`../${path}`, level + 1)
    }
}

export type ApiLambdas<T extends ApiDefinition> = {
    [K in keyof T]: T[K] extends ApiDefinition ? ApiLambdas<T[K]> : NodejsFunction
}

const DEFAULT_ARCHITECTURE = Architecture.ARM_64
const DEFAULT_RUNTIME = Runtime.NODEJS_20_X;

const createHttpApi = <T extends ApiDefinition>(
    scope: Construct,
    props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T> | DependentApiProperties<T>,
    customPath = ""
) =>
    new HttpApi(scope, `ProxyCorsHttpApi-${props.apiName}-${customPath}${props.deployFor}`, {
        corsPreflight: { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] },
    })

const addDatabaseProperties =
    <R extends ApiDefinition>(
        props: TSApiDatabaseProperties<R> | DependentApiProperties<R>,
        lambdaProps: NodejsFunctionProps,
        vpc: Vpc,
        database: DatabaseInstance,
        lambdaSG: ISecurityGroup,
        specificLambdaProperties?: NodejsFunctionProps
    ) => {

        return {
            ...lambdaProps,
            ...specificLambdaProperties,
            vpc,
            securityGroups: [lambdaSG],

            environment: {
                ...lambdaProps.environment,
                ...specificLambdaProperties?.environment,
                DB_ENDPOINT_ADDRESS: database!.dbInstanceEndpointAddress,
                DB_NAME: props.dbProps.databaseName,
                DB_SECRET_ARN: database!.secret?.secretFullArn
            },
        } as NodejsFunctionProps;
    }

const connectLambdaToDatabase =
    <R extends ApiDefinition>(
        database: DatabaseInstance,
        databaseSG: ISecurityGroup,
        lambda: NodejsFunction,
        lambdaSG: ISecurityGroup,
        props: TSApiDatabaseProperties<R>,
        camelCasePath: string
    ) => {
        database.secret?.grantRead(lambda);
        databaseSG!.addIngressRule(
            lambdaSG,
            Port.tcp(database.instanceEndpoint.port),
            `Lamda2PG-${camelCasePath}-${props.deployFor}`
        )
    }

const createLambda = <R extends ApiDefinition>(
    scope: Construct,
    props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R> | DependentApiProperties<R>,
    subPath: string,
    sharedLayer: LayerVersion,
    key: string,
    filePath: string,
    specificLambdaProperties?: LambdaProperties,
    vpc?: Vpc,
    database?: DatabaseInstance,
    databaseSG?: ISecurityGroup,
    lambdaSG?: ISecurityGroup
) => {
    const handler = requireHereAndUp(`${filePath}`)[key];
    const resourcesConnected = handler?.connectedResources;
    if (!resourcesConnected) throw new Error(`No appropriate handler connected for ${filePath}`);
    if (!props.connectDatabase && Array.from(resourcesConnected).includes(ConnectedResources.DATABASE.toString()))
        throw new Error(`Trying to connect database to a lambda on a non-connected stack in ${filePath}`);

    const camelCasePath = kebabToCamel(filePath.replace("/", "-"))

    const logGroup = new LogGroup(scope, `TSApiLambdaLog-${camelCasePath}${props.deployFor}`, {
        removalPolicy: RemovalPolicy.DESTROY,
        retention: RetentionDays.THREE_DAYS,
        ...props.logGroupProps,
        ...specificLambdaProperties?.logGroupProps
    });

    let lambdaProperties = {
        entry: `${filePath}.ts`,
        handler: key as string,
        description: `${props.description} - ${subPath}/${key as string} (${props.deployFor})`,
        runtime: DEFAULT_RUNTIME,
        memorySize: 256,
        architecture: DEFAULT_ARCHITECTURE,
        timeout: Duration.seconds(60),
        logGroup,
        layers: [sharedLayer, ...(specificLambdaProperties?.extraLayers ?? props.extraLayers ?? [])],
        bundling: {
            minify: true,
            sourceMap: true,
            ...(props.extraBundling ?? {}),
            ...specificLambdaProperties?.extraBundling
        },
        ...props.lambdaProps,
        ...specificLambdaProperties?.nodejsFunctionProps,
        environment: {
            ...props.lambdaProps?.environment,
            ...specificLambdaProperties?.nodejsFunctionProps?.environment
        }
    } as NodejsFunctionProps;
    if (props.connectDatabase)
        lambdaProperties = addDatabaseProperties(
            props,
            lambdaProperties,
            vpc!, database!, lambdaSG!,
            specificLambdaProperties?.nodejsFunctionProps
        );

    const lambda = new NodejsFunction(
        scope,
        `TSApiLambda-${camelCasePath}${props.deployFor}`,
        lambdaProperties
    );

    if (props.connectDatabase)
        connectLambdaToDatabase(database!, databaseSG!, lambda, lambdaProperties.securityGroups![0], props, camelCasePath);

    if (specificLambdaProperties?.schedules) {
        specificLambdaProperties.schedules.forEach((schedule, idx) => {
            const eventRule = new Rule(scope, `TSApiLambdaSchedule${idx}-${camelCasePath}${props.deployFor}`, {
                schedule: Schedule.cron(schedule.cron)
            })
            eventRule.addTarget(new LambdaFunction(lambda, {
                event: RuleTargetInput.fromObject({ body: schedule.eventBody ?? "{}" })
            }))
        })
    }

    return lambda
}

const connectLambda =
    <R extends ApiDefinition>(
        scope: Construct,
        props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R> | DependentApiProperties<R>,
        subPath: string,
        httpApi: HttpApi,
        sharedLayer: LayerVersion,
        key: string,
        keyKebabCase: string,
        specificLambdaProperties: LambdaProperties,
        vpc?: Vpc,
        database?: DatabaseInstance,
        databaseSG?: ISecurityGroup,
        lambdaSG?: ISecurityGroup
    ) => {
        const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`;
        const lambda = createLambda(
            scope,
            props,
            subPath,
            sharedLayer,
            key,
            filePath,
            specificLambdaProperties,
            vpc,
            database, databaseSG, lambdaSG)

        const lambdaIntegration = new HttpLambdaIntegration(
            `Integration-${props.lambdaPath}-${keyKebabCase}-${subPath.replace("/", "-")}-${props.deployFor}`,
            lambda
        );
        httpApi.addRoutes({
            integration: lambdaIntegration,
            methods: [HttpMethod.POST],
            path: `${subPath}/${keyKebabCase}`
        });

        return lambda;
    }


const createLambdasForApi =
    <R extends ApiDefinition>(
        scope: Construct,
        props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R> | DependentApiProperties<R>,
        subPath: string,
        apiMetadata: ApiMetadata<R>,
        httpApi: HttpApi,
        sharedLayer: LayerVersion,
        lambdaPropertiesTree?: LambdaPropertiesTree<R>,
        vpc?: Vpc,
        database?: DatabaseInstance,
        databaseSG?: ISecurityGroup,
        lambdaSG?: ISecurityGroup
    ) => {
        const lambdas = {} as ApiLambdas<R>;
        for (const [key, data] of apiMetadata.members) {
            if (props.apiExclusions?.includes((data as NamedMetadata).path)) continue
            const keyKebabCase = camelToKebab(key as string);
            if (data.dataType === "api")
                (lambdas as any)[key] = createLambdasForApi(
                    scope,
                    props,
                    `${subPath}/${keyKebabCase}`,
                    data,
                    httpApi,
                    sharedLayer,
                    (lambdaPropertiesTree as any)?.[key],
                    vpc,
                    database, databaseSG, lambdaSG
                );
            else
                (lambdas as any)[key] = connectLambda(
                    scope,
                    props,
                    subPath,
                    httpApi,
                    sharedLayer,
                    key as string,
                    keyKebabCase,
                    (lambdaPropertiesTree as any)?.[key],
                    vpc,
                    database, databaseSG, lambdaSG
                );
        }
        return lambdas;
    }

export type DependentApiProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: true,
    database: DatabaseInstance,
    databaseSG: ISecurityGroup,
    lambdaSG: ISecurityGroup,
    dbProps: {
        databaseName: string
    },
    vpc: Vpc,
    sharedLayer: LayerVersion
}

export class DependentApiConstruct<T extends ApiDefinition> extends Construct {
    readonly httpApi: HttpApi
    readonly lambdas: ApiLambdas<T>

    constructor(
        scope: Construct,
        id: string,
        props: DependentApiProperties<T>
    ) {
        super(scope, id)

        this.httpApi = createHttpApi(this, props, kebabToCamel(props.apiMetadata.path.replace("/", "-")))

        this.lambdas = createLambdasForApi(
            this,
            props, props.apiMetadata.path,
            props.apiMetadata,
            this.httpApi,
            props.sharedLayer,
            props.lambdaPropertiesTree,
            props.vpc, props.database, props.databaseSG,
            props.lambdaSG
        )
    }
}

export class TSApiConstruct<T extends ApiDefinition> extends Construct {
    readonly httpApi: HttpApi
    readonly lambdas: ApiLambdas<T>
    readonly database?: DatabaseInstance
    readonly databaseSG?: SecurityGroup
    readonly lambdaSG?: SecurityGroup
    readonly vpc?: Vpc
    readonly sharedLayer?: LayerVersion
    readonly databaseName?: string

    private listLambdaArchitectures =
        <T extends ApiDefinition>(initialSet: Set<Architecture>, lambdaPropertiesTree?: LambdaPropertiesTree<T>, depth = 0) => {
            if (!lambdaPropertiesTree || depth++ > DEFAULT_SEARCH_DEPTH) return;
            Object.keys(lambdaPropertiesTree)
                .forEach(key => {
                    if ((lambdaPropertiesTree as any)[key]) {
                        if ((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.architecture)
                            initialSet.add((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.architecture)
                        else this.listLambdaArchitectures(initialSet, (lambdaPropertiesTree as any)[key], depth)
                    }
                })
        }

    private listLambdaRuntimes =
        <T extends ApiDefinition>(initialSet: Set<Runtime>, lambdaPropertiesTree?: LambdaPropertiesTree<T>, depth = 0) => {
            if (!lambdaPropertiesTree || depth++ > DEFAULT_SEARCH_DEPTH) return;
            Object.keys(lambdaPropertiesTree)
                .forEach(key => {
                    if ((lambdaPropertiesTree as any)[key]) {
                        if ((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.runtime)
                            initialSet.add((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.runtime)
                        else this.listLambdaRuntimes(initialSet, (lambdaPropertiesTree as any)[key], depth)
                    }
                })
        }

    constructor(scope: Construct, id: string, props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T>) {
        super(scope, id)

        this.httpApi = createHttpApi(this, props)

        const architecturesSet = new Set<Architecture>([DEFAULT_ARCHITECTURE]);
        if (props.lambdaProps?.architecture) architecturesSet.add(props.lambdaProps?.architecture);
        this.listLambdaArchitectures(architecturesSet, props.lambdaPropertiesTree);
        const runtimesSet = new Set<Runtime>([DEFAULT_RUNTIME]);
        if (props.lambdaProps?.runtime) runtimesSet.add(props.lambdaProps?.runtime);
        this.listLambdaRuntimes(runtimesSet, props.lambdaPropertiesTree);
        this.sharedLayer = new LayerVersion(this, `SharedLayer-${props.apiName}-${props.deployFor}`, {
            code: Code.fromAsset(props.sharedLayerPath ?? `${props.lambdaPath}/shared-layer`),
            compatibleArchitectures: [...architecturesSet],
            compatibleRuntimes: [...runtimesSet]
        })

        if (props.connectDatabase) {
            const vpc = this.vpc = new Vpc(this, `VPC-${props.apiName}-${props.deployFor}`, { natGateways: 1 })
            this.databaseSG = new SecurityGroup(this, `SG-${props.apiName}-${props.deployFor}`, { vpc })
            this.lambdaSG = new SecurityGroup(scope, `TSApiLambdaSG-${props.apiName}-${props.deployFor}`, { vpc })
            this.database = new DatabaseInstance(this, `DB-${props.apiName}-${props.deployFor}`, {
                engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16 }),
                instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
                vpc: this.vpc,
                securityGroups: [this.databaseSG],
                credentials: Credentials.fromGeneratedSecret("postgres"),
                allocatedStorage: 10,
                maxAllocatedStorage: 50,
                ...props.dbProps
            })
            this.databaseName = props.dbProps.databaseName

            if (props.migrationLambda) {
                const keyKebabCase = camelToKebab(props.migrationLambda)
                const subPath = props.migrationLambdaPath ?? "";
                const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`
                const handler = requireHereAndUp(filePath)[props.migrationLambda]
                const resourcesConnected = handler?.connectedResources;
                const checksum = readFileSync(`${filePath}.ts`)
                    .reduce((accumulator, sym) => accumulator = (accumulator + BigInt(sym)) % (65536n ** 2n), 0n)

                if (!handler?.isMigrationHandler || !resourcesConnected)
                    throw new Error(`No appropriate migration handler connected for ${filePath}`);

                const migrationLambda = createLambda(
                    this,
                    props,
                    subPath,
                    this.sharedLayer,
                    props.migrationLambda,
                    filePath,
                    undefined,
                    this.vpc,
                    this.database,
                    this.databaseSG,
                    this.lambdaSG
                )
                const customResourceProvider = new Provider(
                    this, `MigrationResourceProvider-${props.apiName}-${props.deployFor}`, {
                    onEventHandler: migrationLambda
                })
                const customResource = new CustomResource(
                    this, `MigrationResource-${props.apiName}-${props.deployFor}`, {
                    serviceToken: customResourceProvider.serviceToken,
                    resourceType: "Custom::PostgresDatabaseMigration",
                    properties: { Checksum: checksum.toString() }
                })
                customResource.node.addDependency(this.database)
            }

            if (props.bastion) {
                const bastion = new BastionHostLinux(
                    this,
                    `BastionHost-${props.apiName}-${props.deployFor}`, {
                    vpc: this.vpc,
                    instanceType: new InstanceType("t3.nano"),
                    subnetSelection: { subnetType: SubnetType.PUBLIC }
                })
                props.bastion.openTo.forEach(address => bastion.allowSshAccessFrom(Peer.ipv4(address)))
                this.database.connections.allowFrom(
                    bastion.connections,
                    Port.tcp(this.database.instanceEndpoint.port),
                    `${props.apiName} API Bastion connection for the RDP database`
                )
            }
        }

        this.lambdas = createLambdasForApi(
            this,
            props, "",
            props.apiMetadata,
            this.httpApi,
            this.sharedLayer,
            props.lambdaPropertiesTree,
            this.vpc, this.database, this.databaseSG, this.lambdaSG)
    }
}