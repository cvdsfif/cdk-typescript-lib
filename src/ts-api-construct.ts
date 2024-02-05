import { Duration, RemovalPolicy, StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { ISecurityGroup, InstanceClass, InstanceSize, InstanceType, Port, SecurityGroup, Vpc } from "aws-cdk-lib/aws-ec2";
import { Architecture, Code, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { BundlingOptions, NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, LogGroupProps, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion } from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";
import { ApiDefinition, ApiMetadata } from "typizator";
import { ConnectedResources, PING } from "typizator-handler";

export interface ExtendedStackProps extends StackProps {
    deployFor: string
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
    extraBundling?: Partial<BundlingOptions>
}

export type TSApiPlainProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: false
}

export type TSApiDatabaseProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: true,
    databaseName: string
}

const camelToKebab = (src: string | String) => src.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
const kebabToCamel = (src: string | String) => src.replace(/(?:_|-| |\b)(\w)/g, (_, p1) => p1.toUpperCase());

const requireHereAndUp: any = (path: string, level = 0) => {
    try {
        return require(path);
    } catch (e) {
        if (level > 8) throw new Error(`Handler not found, searching up to ${path}`);
        return requireHereAndUp(`../${path}`, level + 1);
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
                    DB_NAME: props.databaseName,
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

    private connectLambda =
        <R extends ApiDefinition>(
            props: TSApiPlainProperties<R> | TSApiDatabaseProperties<R>,
            subPath: string,
            httpApi: HttpApi,
            sharedLayer: LayerVersion,
            key: string,
            keyKebabCase: string
        ) => {
            const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`;
            const handler = requireHereAndUp(`${filePath}`)[key];
            const resourcesConnected = handler?.connectedResources;
            if (!resourcesConnected) throw new Error(`No appropriate handler connected for ${filePath}`);
            if (!props.connectDatabase && Array.from(resourcesConnected).includes(ConnectedResources.DATABASE.toString()))
                throw new Error(`Trying to connect database to a lambda on a non-connected stack in ${filePath}`);

            const camelCasePath = kebabToCamel(filePath.replace("/", "-"));

            const logGroup = new LogGroup(this, `TSApiLambdaLog-${camelCasePath}${props.deployFor}`, {
                removalPolicy: RemovalPolicy.DESTROY,
                retention: RetentionDays.THREE_DAYS,
                ...props.logGroupProps
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
                layers: [sharedLayer, ...(props.extraLayers ?? [])],
                bundling: {
                    minify: true,
                    sourceMap: true,
                    ...(props.extraBundling ?? {})
                },
                ...props.lambdaProps
            } as NodejsFunctionProps;
            if (props.connectDatabase)
                lambdaProperties = this.addDatabaseProperties(props, lambdaProperties, camelCasePath);

            const lambda = new NodejsFunction(
                this,
                `TSApiLambda-${camelCasePath}`,
                lambdaProperties
            );

            if (props.connectDatabase)
                this.connectLambdaToDatabase(lambda, lambdaProperties.securityGroups![0], props, camelCasePath);

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
            sharedLayer: LayerVersion
        ) => {
            const lambdas = {} as ApiLambdas<R>;
            for (const [key, data] of apiMetadata.members) {
                const keyKebabCase = camelToKebab(key as string);
                if (data.dataType === "api")
                    (lambdas as any)[key] = this.createLambdasForApi(props, `${subPath}/${keyKebabCase}`, data, httpApi, sharedLayer);
                else
                    (lambdas as any)[key] = this.connectLambda(props, subPath, httpApi, sharedLayer, key as string, keyKebabCase);
            }
            return lambdas;
        }

    constructor(scope: Construct, id: string, props: TSApiPlainProperties<T> | TSApiDatabaseProperties<T>) {
        super(scope, id);

        this.httpApi = new HttpApi(this, `ProxyCorsHttpApi-${props.apiName}-${props.deployFor}`, {
            corsPreflight: { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] },
        });

        if (props.connectDatabase) {
            const vpc = this.vpc = new Vpc(this, `VPC-${props.apiName}-${props.deployFor}`, { natGateways: 1 });
            this.databaseSG = new SecurityGroup(this, `SG-${props.apiName}-${props.deployFor}`, { vpc });
            this.database = new DatabaseInstance(this, `DB-${props.apiName}-${props.deployFor}`, {
                engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16 }),
                databaseName: props.databaseName,
                instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
                vpc: this.vpc,
                securityGroups: [this.databaseSG],
                credentials: Credentials.fromGeneratedSecret("postgres"),
                allocatedStorage: 10,
                maxAllocatedStorage: 50
            });
        }

        const sharedLayer = new LayerVersion(this, `SharedLayer-${props.apiName}-${props.deployFor}`, {
            code: Code.fromAsset(props.sharedLayerPath ?? `${props.lambdaPath}/shared-layer`),
            compatibleArchitectures: [props.lambdaProps?.architecture ?? this.DEFAULT_ARCHITECTURE],
            compatibleRuntimes: [props.lambdaProps?.runtime ?? this.DEFAULT_RUNTIME]
        })

        this.lambdas = this.createLambdasForApi(
            props, "",
            props.apiMetadata,
            this.httpApi,
            sharedLayer);
    }
}