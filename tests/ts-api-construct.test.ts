import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Construct } from "constructs";
import { simpleApiS } from "./lambda/shared/simple-api-definition";
import { ApiDefinition } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiPlainProperties } from "../src/ts-api-construct";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";

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
                connectDatabase: false,
                lambdaPropertiesTree: {
                    meow: {
                        schedules: [{
                            cron: { minute: "0/1" }
                        }]
                    },
                    noMeow: {
                        nodejsFunctionProps: {
                            runtime: Runtime.NODEJS_18_X
                        },
                        logGroupProps: {
                            removalPolicy: RemovalPolicy.SNAPSHOT
                        }
                    },
                    cruel: {
                        world: {
                            nodejsFunctionProps: {
                                runtime: Runtime.NODEJS_16_X,
                                architecture: Architecture.X86_64
                            }
                        }
                    }
                }
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

        let allLogGroups = template.findResources("AWS::Logs::LogGroup", Match.anyValue())
        let helloWorldLogGroupKey = Object.keys(allLogGroups).find(key => key.includes("HelloWorld"));
        expect(allLogGroups[helloWorldLogGroupKey!].DeletionPolicy).toEqual("Delete")
        const noMeowLogGroupKey = Object.keys(allLogGroups).find(key => key.includes("NoMeow"));
        expect(allLogGroups[noMeowLogGroupKey!].DeletionPolicy).toEqual("Snapshot")

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
                    runtime: Runtime.NODEJS_18_X,
                    architecture: Architecture.ARM_64
                },
                logGroupProps: {
                    removalPolicy: RemovalPolicy.RETAIN
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
        allLogGroups = template.findResources("AWS::Logs::LogGroup", Match.anyValue())
        helloWorldLogGroupKey = Object.keys(allLogGroups).find(key => key.includes("HelloWorld"));
        expect(allLogGroups[helloWorldLogGroupKey!].DeletionPolicy).toEqual("Retain")
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
                "CompatibleRuntimes": Match.arrayWith(["nodejs20.x", "nodejs18.x", "nodejs16.x"])
            })
        );
    });

    test("Should set the timers as required", () => {
        template.hasResourceProperties("AWS::Events::Rule",
            Match.objectLike({
                "ScheduleExpression": "cron(0/1 * * * ? *)"
            })
        )
        template.hasResourceProperties("AWS::Events::Rule",
            Match.objectLike({
                "Targets": [Match.objectLike({
                    "Arn": { "Fn::GetAtt": [Match.stringLikeRegexp("Meow"), "Arn"] },
                    "Input": "{\"body\":\"{}\"}"
                })]
            })
        )
    })
});