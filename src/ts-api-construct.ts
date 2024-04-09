import { CustomResource, Duration, RemovalPolicy, StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, DomainName, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { BastionHostLinux, ISecurityGroup, InstanceClass, InstanceSize, InstanceType, Peer, Port, SecurityGroup, SubnetType, Vpc, VpcProps } from "aws-cdk-lib/aws-ec2";
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
import { ARecord, HostedZone, IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";

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
 * Special properties defining how the tree node and its child nodes can be accessed
 */
export type AccessProperties = {
    /**
     * Optional list of IP addresses from where it is permitted to access the elements of the subree
     */
    authorizedIps?: string[] & { 0: string }
    /**
     * Optional bitmask that the client's authorization must match to allow the access to the elements of the subtree
     */
    accessMask?: number
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
     * - sourceMap: false
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
} & AccessProperties

/**
 * Tree allowing to assign a specific set of properties to every lambda present on the API. Matches the structure of the API for the construct, each field corresponding to the function name  contains an instance of `LambdaProperties`
 */
export type LambdaPropertiesTree<T extends ApiDefinition> = {
    [K in keyof T]?:
    T[K] extends ApiDefinition ?
    LambdaPropertiesTree<T[K]> :
    LambdaProperties
} & AccessProperties

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
    apiExclusions?: string[],
    /**
     * Configures a custom domain name for the HTTP API managed by the construct.
     * It must belong to a zone that you host on Route53
     * 
     * @example
     * ```ts
     * {    // For api.example.org:
     *      hostedZoneName: "example.org",
     *      domainNamePrefix: "api"
     * }
     * ```
     */
    apiDomainData?: {
        /**
         * Domain name that belongs to you 
         */
        hostedZoneName: string,
        /**
         * Domain name prefix.
         */
        domainNamePrefix: string,
        /**
         * This can be used in few very limited cases like advanced testing. Replaces the standard procedure of domain lookup
         * @param scope CDK construct context
         * @param props Properties for the API creation
         * @param customPath If not empty, the path to add to the end of the API HTTP entry point. Used essentially for dependent constructs
         * @returns New hosted zone
         */
        customDomainLookup?: (
            scope: Construct,
            props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T>,
            customPath: string) => IHostedZone
    }
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
    errorHandlerLambda?: string,
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
     * Optional properties of the VPC overriding the default CDK props
     */
    vpcProps?: Partial<VpcProps>,
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

/**
 * Creates a test mock of the hosted zone lookup
 * @param scope CDK construct scope. `this` from the stack for example
 * @param _ Not used in the mock implementation 
 * @param _1  Not used in the mock implementation
 * @returns Hosted zone that can be used in the test synthesis
 */
export const customDomainLookupMock = <T extends ApiDefinition>(
    scope: Construct,
    _: TSApiPlainProperties<T> | TSApiDatabaseProperties<T>,
    _1: string) => HostedZone
        .fromHostedZoneAttributes(scope, "R53Domain",
            { hostedZoneId: "ID", zoneName: "test.com" })

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

const lookupHostedZone = <T extends ApiDefinition>(
    scope: Construct,
    props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T>,
    customPath: string) =>
    HostedZone.fromLookup(scope, `parent-zone-${props.apiName}-${customPath}${props.deployFor}`, {
        domainName: props.apiDomainData!.hostedZoneName
    })


const createHttpApi = <T extends ApiDefinition>(
    scope: Construct,
    props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T> | InnerDependentApiProperties<T>,
    customPath = ""
) => {
    if (!props.apiDomainData) {
        const api = new HttpApi(scope, `ProxyCorsHttpApi-${props.apiName}-${customPath}${props.deployFor}`, {
            corsPreflight: { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] },
        })
        return ({
            api,
            domainName: api.url
        })
    }
    const hostedZone = props.apiDomainData.customDomainLookup ?
        props.apiDomainData.customDomainLookup(scope, props, customPath) :
        lookupHostedZone(scope, props, customPath)
    const domainName = `${props.apiDomainData.domainNamePrefix}.${props.apiDomainData.hostedZoneName}`
    const certificate = new Certificate(scope, `api-certificate-${props.apiName}-${customPath}${props.deployFor}`, {
        domainName,
        validation: CertificateValidation.fromDns(hostedZone)
    })
    const domain = new DomainName(scope, `domain-${props.apiName}-${customPath}${props.deployFor}`, {
        domainName, certificate
    })
    const api = new HttpApi(scope, `ProxyCorsHttpApi-${props.apiName}-${customPath}${props.deployFor}`, {
        corsPreflight: { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] },
        defaultDomainMapping: {
            domainName: domain
        }
    })
    const arecord = new ARecord(scope, `arecord-${props.apiName}-${customPath}${props.deployFor}`, {
        recordName: props.apiDomainData.domainNamePrefix,
        zone: hostedZone,
        target: RecordTarget.fromAlias(
            new ApiGatewayv2DomainProperties(
                domain.regionalDomainName,
                domain.regionalHostedZoneId
            )
        )
    })
    return {
        api,
        domainName: `https://${arecord.domainName}`
    }
}

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
            sourceMap: false,
            ...(props.extraBundling ?? {}),
            ...specificLambdaProperties?.extraBundling
        },
        ...props.lambdaProps,
        ...specificLambdaProperties?.nodejsFunctionProps,
        environment: {
            ...props.lambdaProps?.environment,
            ...specificLambdaProperties?.nodejsFunctionProps?.environment,
            IP_LIST: specificLambdaProperties?.authorizedIps ? JSON.stringify(specificLambdaProperties?.authorizedIps) : undefined,
            ACCESS_MASK: specificLambdaProperties?.accessMask ? JSON.stringify(specificLambdaProperties?.accessMask) : undefined
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
        const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`
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

const fillLocalAccessProperties = (
    lambdaPropertiesTree?: AccessProperties,
    accessProperties?: AccessProperties
) => {
    const localAccessProperties = {
        ...accessProperties,
    } satisfies AccessProperties
    if (lambdaPropertiesTree?.accessMask) localAccessProperties.accessMask = lambdaPropertiesTree.accessMask
    if (lambdaPropertiesTree?.authorizedIps) localAccessProperties.authorizedIps = lambdaPropertiesTree.authorizedIps
    return localAccessProperties
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
            const keyKebabCase = camelToKebab(key as string)
            const localAccessProperties = fillLocalAccessProperties(lambdaPropertiesTree, (lambdaPropertiesTree as any)?.[key])
            if (data.dataType === "api")
                (lambdas as any)[key] = createLambdasForApi(
                    scope,
                    props,
                    `${subPath}/${keyKebabCase}`,
                    data,
                    httpApi,
                    sharedLayer,
                    {
                        ...(lambdaPropertiesTree as any)?.[key],
                        ...localAccessProperties
                    },
                    vpc,
                    database, databaseSG, lambdaSG
                )
            else
                (lambdas as any)[key] = connectLambda(
                    scope,
                    props,
                    subPath,
                    httpApi,
                    sharedLayer,
                    key as string,
                    keyKebabCase,
                    {
                        ...(lambdaPropertiesTree as any)?.[key],
                        ...localAccessProperties
                    },
                    vpc,
                    database, databaseSG, lambdaSG
                )
        }
        return lambdas
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

const listLambdaArchitectures =
    <T extends ApiDefinition>(initialSet: Set<Architecture>, lambdaPropertiesTree?: LambdaPropertiesTree<T>, depth = 0) => {
        if (!lambdaPropertiesTree || depth++ > DEFAULT_SEARCH_DEPTH) return;
        Object.keys(lambdaPropertiesTree)
            .forEach(key => {
                if ((lambdaPropertiesTree as any)[key]) {
                    if ((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.architecture)
                        initialSet.add((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.architecture)
                    else listLambdaArchitectures(initialSet, (lambdaPropertiesTree as any)[key], depth)
                }
            })
    }

const listLambdaRuntimes =
    <T extends ApiDefinition>(initialSet: Set<Runtime>, lambdaPropertiesTree?: LambdaPropertiesTree<T>, depth = 0) => {
        if (!lambdaPropertiesTree || depth++ > DEFAULT_SEARCH_DEPTH) return;
        Object.keys(lambdaPropertiesTree)
            .forEach(key => {
                if ((lambdaPropertiesTree as any)[key]) {
                    if ((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.runtime)
                        initialSet.add((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.runtime)
                    else listLambdaRuntimes(initialSet, (lambdaPropertiesTree as any)[key], depth)
                }
            })
    }

const createSharedLayerForConstruct = <T extends ApiDefinition>(
    scope: Construct,
    apiName: string,
    deployFor: string,
    lambdaPath: string,
    sharedLayerPath?: string,
    lambdaProps?: NodejsFunctionProps,
    lambdaPropertiesTree?: LambdaPropertiesTree<T>
) => {
    const architecturesSet = new Set<Architecture>([DEFAULT_ARCHITECTURE]);
    if (lambdaProps?.architecture) architecturesSet.add(lambdaProps.architecture);
    listLambdaArchitectures(architecturesSet, lambdaPropertiesTree);
    const runtimesSet = new Set<Runtime>([DEFAULT_RUNTIME]);
    if (lambdaProps?.runtime) runtimesSet.add(lambdaProps.runtime);
    listLambdaRuntimes(runtimesSet, lambdaPropertiesTree);
    return new LayerVersion(scope, `SharedLayer-${apiName}-${deployFor}`, {
        code: Code.fromAsset(sharedLayerPath ?? `${lambdaPath}/shared-layer`),
        compatibleArchitectures: [...architecturesSet],
        compatibleRuntimes: [...runtimesSet]
    })
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
     * URL used to access the API
     */
    readonly apiUrl: string
    /**
     * Tree of lambdas created by this construct
     */
    readonly lambdas: ApiLambdas<T>

    private readonly sharedLayer: LayerVersion

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

        this.sharedLayer = createSharedLayerForConstruct(
            this,
            props.apiName,
            props.deployFor,
            props.lambdaPath,
            props.sharedLayerPath,
            props.lambdaProps,
            props.lambdaPropertiesTree
        )

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
            sharedLayer: this.sharedLayer
        } as InnerDependentApiProperties<T>
        const apiInfo = createHttpApi(this, innerProps, kebabToCamel(innerProps.apiMetadata.path.replace("/", "-")))
        this.httpApi = apiInfo.api
        this.apiUrl = apiInfo.domainName!

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
     * URL used to access the API
     */
    readonly apiUrl: string
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
     * Name of the database created
     */
    readonly databaseName?: string
    /**
     * Bastion host resource, if configured
     */
    readonly bastion?: BastionHostLinux

    private readonly sharedLayer?: LayerVersion

    /**
     * Creates the construct
     * @param scope Parent scope, usually holging stack
     * @param id ID of the construct, has to be unique for your AWS account
     * @param props Properties, as defining in the corresponding types
     */
    constructor(scope: Construct, id: string, props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T>) {
        super(scope, id)

        const apiInfo = createHttpApi(this, props)
        this.httpApi = apiInfo.api
        this.apiUrl = apiInfo.domainName!

        this.sharedLayer = createSharedLayerForConstruct(
            this,
            props.apiName,
            props.deployFor,
            props.lambdaPath,
            props.sharedLayerPath,
            props.lambdaProps,
            props.lambdaPropertiesTree
        )

        if (props.connectDatabase) {
            const vpc = this.vpc = new Vpc(this, `VPC-${props.apiName}-${props.deployFor}`, {
                natGateways: 1,
                ...props.vpcProps
            })
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
                this.bastion = new BastionHostLinux(
                    this,
                    `BastionHost-${props.apiName}-${props.deployFor}`, {
                    vpc: this.vpc,
                    instanceType: new InstanceType("t3.nano"),
                    subnetSelection: { subnetType: SubnetType.PUBLIC }
                })
                props.bastion.openTo.forEach(address => this.bastion?.allowSshAccessFrom(Peer.ipv4(address)))
                this.database.connections.allowFrom(
                    this.bastion.connections,
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