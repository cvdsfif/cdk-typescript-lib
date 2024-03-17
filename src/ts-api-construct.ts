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

/**
 * Extended properties for the stack creation.
 * Allow to define the deployment target (production, staging, test...)
 */
export interface ExtendedStackProps extends StackProps {
    /**
     * Deployment target that will be a part of the names of CDK resources created by the stack. Allows to deploy different versions of the stack side-by-side
     */
    deployFor: string
}

/**
 * Properties of the lambda function created on the stack
 */
export type LambdaProperties = {
    /**
     * Overrides the default properties of the NodejsFunction created
     * 
     * The actual defaults are, in addition to those defined by CDK:
     * - entry: `{lambdaPath}/{lambdaName}.ts`, where {lambdaPath} defined in `TSApiProperties` and {lambdaName} is the name of the API function implemented converted to _kebab-case_
     * - handler: name of the implemented API function in _camelCase_
     * - description: created automatically from the implemented API function name and environment type (production, staging...)
     * - runtime: as defined by the `DEFAULT_RUNTIME` constant in this module
     * - memorySize: 256M
     * - architecture: as defined by the `DEFAULT_ARCHITECTURE` constant in this module
     * - timeout: 60 seconds
     * - loggroup: default one, created by the construct
     * - layers: default shared layer created by the construct plus eventually the layers defined in the `extraLayers` properties. It is better not to override this default.
     * - bundling: minified with source map. It is better not to override this parameter directly but rather use the `extraBundling` properties
     * - environment: merge of environment variables defined at different levels. Better not to override this directly
     */
    nodejsFunctionProps?: Partial<NodejsFunctionProps>,
    /**
     * Overrides the default properties of the log group
     */
    logGroupProps?: LogGroupProps,
    /**
     * Bundling parameters for esbuild transpiling the Typescript source into Javascript. Use this instead of overriding `bundling` directly to avoid breaking other defaults
     * 
     * The actual defaults are:
     * - minify: true
     * - sourceMap: true
     */
    extraBundling?: Partial<BundlingOptions>,
    /**
     * Lambda layers to add to the stack, in addition to the default one
     */
    extraLayers?: LayerVersion[],
    /**
     * Schedule on which to call the lambda
     */
    schedules?: [{
        /**
         * Cron options defining when to schedule the lambda function call
         */
        cron: CronOptions,
        /**
         * Stringified JSON object to send to the function as an argument
         */
        eventBody?: string
    }]
}

/**
 * Tree allowing to assign a specific set of properties to every lambda present on the API. Matches the structure of the API for the construct, each field corresponding to the function name  contains an instance of `LambdaProperties`
 */
export type LambdaPropertiesTree<T extends ApiDefinition> = {
    [K in keyof T]?:
    T[K] extends ApiDefinition ?
    LambdaPropertiesTree<T[K]> :
    LambdaProperties
}

/**
 * Properties defining how the stack is constructed from the `typizator` API definition
 */
export type TSApiProperties<T extends ApiDefinition> = {
    /**
     * Destination environment, i.e. production, staging, dev etc...
     */
    deployFor: string,
    /**
     * API name (unique for your AWS account)
     */
    apiName: string,
    /**
     * Human-readable description of the API
     */
    description: string,
    /**
     * Metadata of the `typizator` API holding its structure and defining what lambdas to create to implement the API
     */
    apiMetadata: ApiMetadata<T>,
    /**
     * Path to the lambda implementation files, relative to your project's root
     */
    lambdaPath: string,
    /**
     * CDK properties overriding the defaults, as defined in `NodejsFunctionProps`. If you want to define individual properties for some functions, use `lambdaPropertiesTree`
     */
    lambdaProps?: NodejsFunctionProps,
    /**
     * CDK properties overriding the log group, as defined in `NodejsFunctionProps`
     */
    logGroupProps?: LogGroupProps,
    /**
     * Path to the lambda layer, relative to your project's root
     */
    sharedLayerPath?: string,
    /**
     * List of additional layers to inject into the stack
     */
    extraLayers?: LayerVersion[],
    /**
     * Additional bundling options for all the lambdas
     */
    extraBundling?: Partial<BundlingOptions>,
    /**
     * Tree of optional additional properties that you can define for any function of your API
     */
    lambdaPropertiesTree?: LambdaPropertiesTree<T>,
    /**
     * Packages to _not_ to bundle with the lambdas. Usually those already present on AWS and those you put on your shared layer
     */
    apiExclusions?: string[]
}

/**
 * Properties for lambdas without database connection
 */
export type TSApiPlainProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    /**
     * Discriminator saying that the construct will not create a database connection to share between lambdas
     */
    connectDatabase: false
}

/**
 * Properties for lambdas with database connection
 */
export type TSApiDatabaseProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    /**
     * Discriminator saying that the construct will not create a database connection to share between lambdas
     */
    connectDatabase: true,
    /**
     * Name of the lambda function ensuring the database schema creation and its migration after updates
     */
    migrationLambda?: string,
    /**
     * Path to the migrtion lambda. Usually the same as for the other lambdas
     */
    migrationLambdaPath?: string,
    /**
     * Properties of the database overriding the defaults of the construct and of CDK
     * 
     * The actual construct's defaults are:
     * - engine: Postgres 16, latest minor version
     * - instanceType: t3micro
     * - vpc: created inside the construct
     * - securityGroups: creted inside the construct
     * - credentials: generated and stored in AWS secret ("postgres")
     * - allocatedStorage: 10Gb
     * - maxAllocatedStorage: 50Gb
     */
    dbProps: Partial<Omit<DatabaseInstanceProps, "databaseName">> & { databaseName: string },
    /**
     * If defined, creates a Bastion Linux server for manual access to the database through an SSH tunnel
     */
    bastion?: {
        /**
         * List of CIDR IP addresses defining who can access the bastion
         */
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

/**
 * Tree matching the API tree containing CDK lambda functions definitions once the stack is created
 */
export type ApiLambdas<T extends ApiDefinition> = {
    [K in keyof T]: T[K] extends ApiDefinition ? ApiLambdas<T[K]> : NodejsFunction
}

/**
 * Default architecture for the lambdas created
 */
export const DEFAULT_ARCHITECTURE = Architecture.ARM_64
/**
 * Default NodeJS runtime for the lambdas created
 */
export const DEFAULT_RUNTIME = Runtime.NODEJS_20_X;

const createHttpApi = <T extends ApiDefinition>(
    scope: Construct,
    props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T> | InnerDependentApiProperties<T>,
    customPath = ""
) =>
    new HttpApi(scope, `ProxyCorsHttpApi-${props.apiName}-${customPath}${props.deployFor}`, {
        corsPreflight: { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] },
    })

const addDatabaseProperties =
    <R extends ApiDefinition>(
        props: TSApiDatabaseProperties<R> | InnerDependentApiProperties<R>,
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
    props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R> | InnerDependentApiProperties<R>,
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
        props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R> | InnerDependentApiProperties<R>,
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
        props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R> | InnerDependentApiProperties<R>,
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
        for (const key of Object.keys(apiMetadata.implementation)) {
            const data = (apiMetadata.implementation as any)[key].metadata
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

/**
 * Specific properties for the dependent API
 */
export type DependentApiProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    /**
     * Reference of the parent construct to connect to. The construct must connect the API to a database
     */
    parentConstruct: TSApiConstruct<any>
}

type InnerDependentApiProperties<T extends ApiDefinition> = TSApiProperties<T> & {
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

/**
 * Dependent construct allowing to host parts of the API on a different HTTP API endpoint and deploy it as a separate stack
 */
export class DependentApiConstruct<T extends ApiDefinition> extends Construct {
    /**
     * Once the stack is created, contains the HTTP API used by its lambda function as an external entry point
     */
    readonly httpApi: HttpApi
    /**
     * Tree of lambdas created by this construct
     */
    readonly lambdas: ApiLambdas<T>

    /**
     * Creates the ready to deploy construct
     * @param scope Parent scope (usually `this` of the holding stack)
     * @param id Stack ID, unique for your AWS account
     * @param props Properties, as defined for `DependentApiProperties`
     */
    constructor(
        scope: Construct,
        id: string,
        props: DependentApiProperties<T>
    ) {
        super(scope, id)

        const innerProps = {
            ...props,
            parentConstruct: undefined,
            connectDatabase: true,
            database: props.parentConstruct.database,
            databaseSG: props.parentConstruct.databaseSG,
            lambdaSG: props.parentConstruct.lambdaSG,
            dbProps: {
                databaseName: props.parentConstruct.databaseName
            },
            vpc: props.parentConstruct.vpc,
            sharedLayer: props.parentConstruct.sharedLayer
        } as InnerDependentApiProperties<T>
        this.httpApi = createHttpApi(this, innerProps, kebabToCamel(innerProps.apiMetadata.path.replace("/", "-")))

        this.lambdas = createLambdasForApi(
            this,
            innerProps, innerProps.apiMetadata.path,
            innerProps.apiMetadata,
            this.httpApi,
            innerProps.sharedLayer,
            innerProps.lambdaPropertiesTree,
            innerProps.vpc, innerProps.database, innerProps.databaseSG,
            innerProps.lambdaSG
        )
    }
}

/**
 * Creates the main stack implementing your `typizator`-defined API
 */
export class TSApiConstruct<T extends ApiDefinition> extends Construct {
    /**
     * HTTP API enpoint created by the construct
     */
    readonly httpApi: HttpApi
    /**
     * Tree of lambdas created by the construct
     */
    readonly lambdas: ApiLambdas<T>
    /**
     * Database instace created by the construct
     */
    readonly database?: DatabaseInstance
    /**
     * Security group attached to the database instance created by the construct
     */
    readonly databaseSG?: SecurityGroup
    /**
     * Security group for the database-connected lambdas created by the construct
     */
    readonly lambdaSG?: SecurityGroup
    /**
     * VPC created by the construct holding its resources
     */
    readonly vpc?: Vpc
    /**
     * Lambda layers that all the construct's (and dependent constructs') lambdas can access
     */
    readonly sharedLayer?: LayerVersion
    /**
     * Name of the database created
     */
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

    /**
     * Creates the construct
     * @param scope Parent scope, usually holging stack
     * @param id ID of the construct, has to be unique for your AWS account
     * @param props Properties, as defining in the corresponding types
     */
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