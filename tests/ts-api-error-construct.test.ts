import { App, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApiDefinition, apiS } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiDatabaseProperties, TSApiPlainProperties } from "../src/ts-api-construct";
import { Template } from "aws-cdk-lib/assertions";
import { connectedApi } from "./lambda/shared/connected-api-definition";

describe("Testing the cases when the constructs creation should fail", () => {
    const wrongApiS = apiS({
        wrong: { args: [] }
    });

    class TestStack<T extends ApiDefinition> extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiPlainProperties<T> | TSApiDatabaseProperties<T>,
        ) {
            super(scope, id, props);
            new TSApiConstruct(this, "SimpleApi", apiProps);
        }
    }

    test("Should break if a handler is not found", () => {
        const app = new App();
        const props = { deployFor: "staging" };
        expect(() => new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: apiS({
                    notFound: { args: [] }
                }).metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: false
            }
        )).toThrow("Handler not found, searching up to ../../../../../../../../../tests/lambda/not-found");
    })

    test("Should break if a handler is not correctly connected", () => {
        const app = new App();
        const props = { deployFor: "staging" };
        expect(() => new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: wrongApiS.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: false
            }
        )).toThrow("No appropriate handler connected for tests/lambda/wrong");
    });

    test("Should break if a handler is found but tries to obtain a non-available resource", () => {
        const app = new App();
        const props = { deployFor: "staging" };
        expect(() => new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: connectedApi.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: false
            }
        )).toThrow("Trying to connect database to a lambda on a non-connected stack in tests/lambda/connected-function");
    });

    test("Should break if a handler is found but not implemented with a library function", () => {
        const app = new App();
        const props = { deployFor: "staging" };
        expect(() => new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: apiS({ notImplemented: { args: [] } }).metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: false
            }
        )).toThrow("No appropriate handler connected for tests/lambda/not-implemented");
    });
});