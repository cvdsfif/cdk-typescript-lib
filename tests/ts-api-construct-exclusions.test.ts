import { App, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApiDefinition, ApiMetadata } from "typizator";
import { DependentApiProperties, DependentApiConstruct, ExtendedStackProps, TSApiConstruct, TSApiPlainProperties, TSApiDatabaseProperties } from "../src/ts-api-construct";
import { Match, Template } from "aws-cdk-lib/assertions";
import { simpleApiS } from "./lambda/shared/simple-api-definition";

describe("Testing partial exclusions on the API", () => {
    class TestStack<T extends ApiDefinition> extends Stack {
        readonly construct: TSApiConstruct<T>

        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiDatabaseProperties<T>,
        ) {
            super(scope, id, props);
            this.construct = new TSApiConstruct(this, "SimpleApi", apiProps)
        }
    }

    class ConnectedStack<T extends ApiDefinition> extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: DependentApiProperties<T>,
        ) {
            super(scope, id, props);
            new DependentApiConstruct(this, "ChildApi", apiProps)
        }
    }

    let stack: Stack
    let dependentStack: Stack

    const init = () => {
        const app = new App()
        const props = { deployFor: "test" };
        const innerStack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                dbProps: {
                    databaseName: "TestDB"
                },
                lambdaProps: {
                    environment: {
                        ENV1: "a"
                    }
                },
                apiExclusions: [
                    simpleApiS.metadata.implementation.cruel.path,
                    simpleApiS.metadata.implementation.noMeow.path
                ]
            }
        )
        stack = innerStack

        dependentStack = new ConnectedStack(
            app, "DependentStack", props,
            {
                ...props,
                apiName: "TSDependentTestApi",
                description: "Dependent typescript API",
                apiMetadata: (simpleApiS.metadata.members.get("cruel") as ApiMetadata<any>),
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                dbProps: {
                    databaseName: innerStack.construct.databaseName!
                },
                vpc: innerStack.construct.vpc!,
                sharedLayer: innerStack.construct.sharedLayer!,
                database: innerStack.construct.database!,
                databaseSG: innerStack.construct.databaseSG!,
                lambdaSG: innerStack.construct.lambdaSG!
            }
        )
    }


    test("Excluded functions should not appear on the stack", async () => {
        init()
        const template = Template.fromStack(stack)
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("meow")
            })
        )
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("helloWorld")
            })
        )
        template.allResourcesProperties("AWS::Lambda::Function",
            Match.not(
                Match.objectLike({
                    "Description": Match.stringLikeRegexp("world")
                })
            )
        )
        template.allResourcesProperties("AWS::Lambda::Function",
            Match.not(
                Match.objectLike({
                    "Description": Match.stringLikeRegexp("cruel")
                })
            )
        )
        template.allResourcesProperties("AWS::Lambda::Function",
            Match.not(
                Match.objectLike({
                    "Description": Match.stringLikeRegexp("noMeow")
                })
            )
        )
    })

    test("Dependent stack constructs and takes resources from the main one with separate HTTP api", async () => {
        const dependentTemplate = Template.fromStack(dependentStack)
        dependentTemplate.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("world")
            })
        )

        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        })
        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSDependentTestApi-Crueltest",
            "CorsConfiguration": { "AllowMethods": ["*"], "AllowOrigins": ['*'], "AllowHeaders": ['*'] }
        })
    })
})