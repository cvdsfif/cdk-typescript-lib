import { CustomResource, Duration, RemovalPolicy, StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { ISecurityGroup, InstanceClass, InstanceSize, InstanceType, Port, SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { Architecture, Code, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { BundlingOptions, NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, LogGroupProps, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, DatabaseInstanceProps, PostgresEngineVersion } from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";
import { ApiDefinition, ApiMetadata } from "typizator";
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
    lambdaPropertiesTree?: LambdaPropertiesTree<T>
}

export type TSApiPlainProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: false
}

export type TSApiDatabaseProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: true,
    migrationLambda?: string,
    migrationLambdaPath?: string,
    dbProps: Partial<Omit<DatabaseInstanceProps, "databaseName">> & { databaseName: string }
}

const camelToKebab = (src: string | String) => src.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
const kebabToCamel = (src: string | String) => src.replace(/(?:_|-| |\b)(\w)/g, (_, p1) => p1.toUpperCase());

const requireHereAndUp: any = (path: string, level = 0) => {
    try {
        return require(path)
    } catch (e) {
        if (level > 8) throw new Error(`Handler not found, searching up to ${path}`)
        return requireHereAndUp(`../${path}`, level + 1)
    }
}

export type ApiLambdas<T extends ApiDefinition> = {
    [K in keyof T]: T[K] extends ApiDefinition ? ApiLambdas<T[K]> : NodejsFunction
}

export class TSApiConstruct<T extends ApiDefinition> extends Construct {
    private DEFAULT_ARCHITECTURE = Architecture.ARM_64;
    private DEFAULT_RUNTIME = Runtime.NODEJS_20_X;

    readonly httpApi: HttpApi;
    readonly lambdas: ApiLambdas<T>;
    readonly database?: DatabaseInstance;
    readonly databaseSG?: SecurityGroup;
    readonly vpc?: Vpc;

    private addDatabaseProperties =
        <R extends ApiDefinition>(
            props: TSApiDatabaseProperties<R>,
            lambdaProps: NodejsFunctionProps,
            camelCasePath: string
        ) => {
            const lambdaSG = new SecurityGroup(this, `TSApiLambdaSG-${camelCasePath}-${props.deployFor}`, { vpc: this.vpc! });
            return {
                ...lambdaProps,
                vpc: this.vpc,
                securityGroups: [lambdaSG],

                environment: {
                    DB_ENDPOINT_ADDRESS: this.database!.dbInstanceEndpointAddress,
                    DB_NAME: props.dbProps.databaseName,
                    DB_SECRET_ARN: this.database!.secret?.secretFullArn
                },
            } as NodejsFunctionProps;
        }

    private connectLambdaToDatabase =
        <R extends ApiDefinition>(
            lambda: NodejsFunction,
            lambdaSG: ISecurityGroup,
            props: TSApiDatabaseProperties<R>,
            camelCasePath: string
        ) => {
            this.database!.secret?.grantRead(lambda);
            this.databaseSG!.addIngressRule(
                lambdaSG,
                Port.tcp(5432),
                `Lamda2PG-${camelCasePath}-${props.deployFor}`
            )
        }

    private createLambda = <R extends ApiDefinition>(
        props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R>,
        subPath: string,
        sharedLayer: LayerVersion,
        key: string,
        filePath: string,
        specificLambdaProperties?: LambdaProperties
    ) => {
        const handler = requireHereAndUp(`${filePath}`)[key];
        const resourcesConnected = handler?.connectedResources;
        if (!resourcesConnected) throw new Error(`No appropriate handler connected for ${filePath}`);
        if (!props.connectDatabase && Array.from(resourcesConnected).includes(ConnectedResources.DATABASE.toString()))
            throw new Error(`Trying to connect database to a lambda on a non-connected stack in ${filePath}`);

        const camelCasePath = kebabToCamel(filePath.replace("/", "-"));

        const logGroup = new LogGroup(this, `TSApiLambdaLog-${camelCasePath}${props.deployFor}`, {
            removalPolicy: RemovalPolicy.DESTROY,
            retention: RetentionDays.THREE_DAYS,
            ...props.logGroupProps,
            ...specificLambdaProperties?.logGroupProps
        });

        let lambdaProperties = {
            entry: `${filePath}.ts`,
            handler: key as string,
            description: `${props.description} - ${subPath}/${key as string} (${props.deployFor})`,
            runtime: this.DEFAULT_RUNTIME,
            memorySize: 256,
            architecture: this.DEFAULT_ARCHITECTURE,
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
            ...specificLambdaProperties?.nodejsFunctionProps
        } as NodejsFunctionProps;
        if (props.connectDatabase)
            lambdaProperties = this.addDatabaseProperties(props, lambdaProperties, camelCasePath);

        const lambda = new NodejsFunction(
            this,
            `TSApiLambda-${camelCasePath}${props.deployFor}`,
            lambdaProperties
        );

        if (props.connectDatabase)
            this.connectLambdaToDatabase(lambda, lambdaProperties.securityGroups![0], props, camelCasePath);

        if (specificLambdaProperties?.schedules) {
            specificLambdaProperties.schedules.forEach((schedule, idx) => {
                const eventRule = new Rule(this, `TSApiLambdaSchedule${idx}-${camelCasePath}${props.deployFor}`, {
                    schedule: Schedule.cron(schedule.cron)
                })
                eventRule.addTarget(new LambdaFunction(lambda, {
                    event: RuleTargetInput.fromObject({ body: schedule.eventBody ?? "{}" })
                }))
            })
        }

        return lambda
    }

    private connectLambda =
        <R extends ApiDefinition>(
            props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R>,
            subPath: string,
            httpApi: HttpApi,
            sharedLayer: LayerVersion,
            key: string,
            keyKebabCase: string,
            specificLambdaProperties: LambdaProperties
        ) => {
            const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`;
            const lambda = this.createLambda(
                props,
                subPath,
                sharedLayer,
                key,
                filePath,
                specificLambdaProperties)

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

    private createLambdasForApi =
        <R extends ApiDefinition>(
            props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R>,
            subPath: string,
            apiMetadata: ApiMetadata<R>,
            httpApi: HttpApi,
            sharedLayer: LayerVersion,
            lambdaPropertiesTree?: LambdaPropertiesTree<R>
        ) => {
            const lambdas = {} as ApiLambdas<R>;
            for (const [key, data] of apiMetadata.members) {
                const keyKebabCase = camelToKebab(key as string);
                if (data.dataType === "api")
                    (lambdas as any)[key] = this.createLambdasForApi(
                        props,
                        `${subPath}/${keyKebabCase}`,
                        data,
                        httpApi,
                        sharedLayer,
                        (lambdaPropertiesTree as any)?.[key]
                    );
                else
                    (lambdas as any)[key] = this.connectLambda(
                        props,
                        subPath,
                        httpApi,
                        sharedLayer,
                        key as string,
                        keyKebabCase,
                        (lambdaPropertiesTree as any)?.[key]
                    );
            }
            return lambdas;
        }

    private listLambdaArchitectures =
        <T extends ApiDefinition>(initialSet: Set<Architecture>, lambdaPropertiesTree?: LambdaPropertiesTree<T>, depth = 0) => {
            if (!lambdaPropertiesTree || depth++ > 8) return;
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
            if (!lambdaPropertiesTree || depth++ > 8) return;
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
        super(scope, id);

        this.httpApi = new HttpApi(this, `ProxyCorsHttpApi-${props.apiName}-${props.deployFor}`, {
            corsPreflight: { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] },
        });

        const architecturesSet = new Set<Architecture>([this.DEFAULT_ARCHITECTURE]);
        if (props.lambdaProps?.architecture) architecturesSet.add(props.lambdaProps?.architecture);
        this.listLambdaArchitectures(architecturesSet, props.lambdaPropertiesTree);
        const runtimesSet = new Set<Runtime>([this.DEFAULT_RUNTIME]);
        if (props.lambdaProps?.runtime) runtimesSet.add(props.lambdaProps?.runtime);
        this.listLambdaRuntimes(runtimesSet, props.lambdaPropertiesTree);
        const sharedLayer = new LayerVersion(this, `SharedLayer-${props.apiName}-${props.deployFor}`, {
            code: Code.fromAsset(props.sharedLayerPath ?? `${props.lambdaPath}/shared-layer`),
            compatibleArchitectures: [...architecturesSet],
            compatibleRuntimes: [...runtimesSet]
        })

        if (props.connectDatabase) {
            const vpc = this.vpc = new Vpc(this, `VPC-${props.apiName}-${props.deployFor}`, { natGateways: 1 });
            this.databaseSG = new SecurityGroup(this, `SG-${props.apiName}-${props.deployFor}`, { vpc });
            this.database = new DatabaseInstance(this, `DB-${props.apiName}-${props.deployFor}`, {
                engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16 }),
                instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
                vpc: this.vpc,
                securityGroups: [this.databaseSG],
                credentials: Credentials.fromGeneratedSecret("postgres"),
                allocatedStorage: 10,
                maxAllocatedStorage: 50,
                ...props.dbProps
            });

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

                const migrationLambda = this.createLambda(
                    props,
                    subPath,
                    sharedLayer,
                    props.migrationLambda,
                    filePath
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
        }

        this.lambdas = this.createLambdasForApi(
            props, "",
            props.apiMetadata,
            this.httpApi,
            sharedLayer,
            props.lambdaPropertiesTree);
    }
}