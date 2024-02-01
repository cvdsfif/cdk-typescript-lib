import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Construct } from "constructs";
import { simpleApiS } from "./lambda/shared/simple-api-definition";
import { ApiDefinition } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiPlainProperties } from "../src/ts-api-construct";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

describe("Testing the behaviour of the Typescript API construct for CDK", () => {
    class TestStack<T extends ApiDefinition> extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiPlainProperties<T>,
        ) {
            super(scope, id, props);
            new TSApiConstruct(this, "SimpleApi", apiProps);
        }
    }

    let template: Template;

    beforeEach(() => {
        const app = new App();
        const props = { deployFor: "test" };
        const stack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: false
            }
        );
        template = Template.fromStack(stack);
    });

    test("Should create lambdas matching the API structure", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)"
            })
        );
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /noMeow (test)"
            })
        );
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /helloWorld (test)"
            })
        );
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /cruel/world (test)"
            })
        );
    });

    test("Should integrate lambdas with an HTTP api", () => {
        template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSTestApi-test",
            "CorsConfiguration": { "AllowMethods": ["*"], "AllowOrigins": ['*'], "AllowHeaders": ['*'] }
        });

        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("Meow"), "Arn"]
            }
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("NoMeow"), "Arn"]
            }
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("HelloWorld"), "Arn"]
            }
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("CruelWorld"), "Arn"]
            }
        });

        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /hello-world"
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /meow"
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /no-meow"
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        });
    });

    test("Should set the default configuration of each lambda and let the end user modify it", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)",
                "Architectures": ["arm64"],
                "MemorySize": 256,
                "Runtime": "nodejs20.x",
                "Timeout": 60,
                "LoggingConfig": {
                    "LogGroup": { "Ref": Match.stringLikeRegexp("Meow") }
                }
            })
        );
        template.hasResourceProperties("AWS::Logs::LogGroup",
            Match.objectLike({
                "RetentionInDays": 3
            })
        );

        // Create a separate stack with updated Lambda config
        const app = new App();
        const props = { deployFor: "staging" };
        const stack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                lambdaProps: {
                    runtime: Runtime.NODEJS_18_X
                },
                logGroupProps: {
                    retention: RetentionDays.FIVE_DAYS
                },
                connectDatabase: false
            }
        );
        template = Template.fromStack(stack);
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (staging)",
                "Runtime": "nodejs18.x",
                "LoggingConfig": {
                    "LogGroup": { "Ref": Match.stringLikeRegexp("Meow") }
                }
            })
        );
        template.hasResourceProperties("AWS::Logs::LogGroup",
            Match.objectLike({
                "RetentionInDays": 5
            })
        );
    });

    test("Should add a shared layer to lambdas", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)",
                "Layers": [{ "Ref": Match.stringLikeRegexp("SimpleApiSharedLayer") }]
            })
        );
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /noMeow (test)",
                "Layers": [{ "Ref": Match.stringLikeRegexp("SimpleApiSharedLayer") }]
            })
        );
        template.hasResourceProperties("AWS::Lambda::LayerVersion",
            Match.objectLike({
                "CompatibleRuntimes": ["nodejs20.x"]
            })
        );
    });
});