import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Construct } from "constructs";
import { apiS, bigintS, stringS } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiProperties } from "../src/ts-api-construct";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";

describe("Testing the behaviour of the Typescript API construct for CDK", () => {
    const simpleApiS = apiS({
        meow: { args: [], retVal: stringS.notNull },
        noMeow: { args: [] },
        helloWorld: { args: [stringS.notNull, bigintS.notNull], retVal: stringS.notNull },
        cruel: {
            world: { args: [stringS.notNull], retVal: stringS.notNull }
        }
    });

    class TestStack extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiProperties
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
                lambdaPath: "tests/lambda"
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

    test("Should share the API URL", () => {
        expect(
            Object.keys(template.findOutputs("*"))
                .find(key => key.startsWith("SimpleApiTSTestApiURL"))
        ).toBeDefined();
    });

    test("Should set the default configuration of each lambda and let the end user modify it", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)",
                "Architectures": ["arm64"],
                "MemorySize": 256,
                "Runtime": "nodejs20.x",
                "Timeout": 60
            })
        );
        template.hasResourceProperties("AWS::Logs::LogGroup",
            Match.objectLike({
                "RetentionInDays": 3,
                "LogGroupName": {
                    "Fn::Join": [
                        "",
                        ["/aws/lambda/", { "Ref": Match.stringLikeRegexp("Meow") }]
                    ]
                }
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
                }
            }
        );
        template = Template.fromStack(stack);
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (staging)",
                "Runtime": "nodejs18.x"
            })
        );
        template.hasResourceProperties("AWS::Logs::LogGroup",
            Match.objectLike({
                "RetentionInDays": 5,
                "LogGroupName": {
                    "Fn::Join": [
                        "",
                        ["/aws/lambda/", { "Ref": Match.stringLikeRegexp("Meow") }]
                    ]
                }
            })
        );
    });
});