import { BundlingOptions, CfnOutput, Duration, RemovalPolicy, StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Architecture, Code, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, LogGroupProps, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { ApiDefinition, ApiMetadata } from "typizator";

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

const camelToKebab = (src: string | String) => src.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
const kebabToCamel = (src: string | String) => src.replace(/(?:_|-| |\b)(\w)/g, (_, p1) => p1.toUpperCase());

export class TSApiConstruct<T extends ApiDefinition> extends Construct {
    private DEFAULT_ARCHITECTURE = Architecture.ARM_64;
    private DEFAULT_RUNTIME = Runtime.NODEJS_20_X;

    private createLambdasForApi =
        (
            props: TSApiProperties<T>,
            subPath: string,
            apiMetadata: ApiMetadata<T>,
            httpApi: HttpApi,
            sharedLayer: LayerVersion
        ) => {
            for (const [key, data] of apiMetadata.members) {
                const keyKebabCase = camelToKebab(key as string);
                if (data.dataType === "api")
                    this.createLambdasForApi(props, `${subPath}/${keyKebabCase}`, data, httpApi, sharedLayer);
                else {
                    const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`;
                    const camelCasePath = kebabToCamel(filePath.replace("/", "-"));
                    const logGroup = new LogGroup(this, `TSApiLambdaLog-${camelCasePath}`, {
                        removalPolicy: RemovalPolicy.DESTROY,
                        retention: RetentionDays.THREE_DAYS,
                        ...props.logGroupProps
                    });
                    const lambda = new NodejsFunction(
                        this,
                        `TSApiLambda-${camelCasePath}`,
                        {
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
                        });
                    const lambdaIntegration = new HttpLambdaIntegration(
                        `Integration-${props.lambdaPath}-${keyKebabCase}-${subPath.replace("/", "-")}-${props.deployFor}`,
                        lambda
                    );
                    httpApi.addRoutes({
                        integration: lambdaIntegration,
                        methods: [HttpMethod.POST],
                        path: `${subPath}/${keyKebabCase}`
                    });
                }
            }
        }

    constructor(scope: Construct, id: string, props: TSApiProperties<T>) {
        super(scope, id);

        const httpApi = new HttpApi(this, `ProxyCorsHttpApi-${props.apiName}-${props.deployFor}`, {
            corsPreflight: { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] },
        });

        const sharedLayer = new LayerVersion(this, `SharedLayer-${props.apiName}-${props.deployFor}`, {
            code: Code.fromAsset(props.sharedLayerPath ?? `${props.lambdaPath}/shared-layer`),
            compatibleArchitectures: [props.lambdaProps?.architecture ?? this.DEFAULT_ARCHITECTURE],
            compatibleRuntimes: [props.lambdaProps?.runtime ?? this.DEFAULT_RUNTIME]
        })

        this.createLambdasForApi(props, "", props.apiMetadata, httpApi, sharedLayer);

        new CfnOutput(this, `${props.apiName}URL`, { value: httpApi.url! });
    }
}