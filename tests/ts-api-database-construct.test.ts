import { App, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApiDefinition } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiDatabaseProperties, TSApiPlainProperties } from "../src/ts-api-construct";
import { Match, Template } from "aws-cdk-lib/assertions";
import { connectedApi } from "./lambda/shared/connected-api-definition";
import { extendExpectWithToContainStrings } from "./util/expect-contain-strings";

describe("Testing a stack with connected database", () => {
    extendExpectWithToContainStrings()

    class TestStack<T extends ApiDefinition> extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiDatabaseProperties<T> | TSApiPlainProperties<T>,
        ) {
            super(scope, id, props);
            new TSApiConstruct(this, "SimpleApi", apiProps);
        }
    }

    const props = { deployFor: "test" };

    test("Should create a stack with connected database", () => {
        const app = new App();

        const stack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: connectedApi.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                dbProps: {
                    databaseName: "TestDatabase",
                    maxAllocatedStorage: 120
                }
            }
        );
        const template = Template.fromStack(stack)

        template.hasResourceProperties("AWS::RDS::DBInstance",
            Match.objectLike({
                "DBName": "TestDatabase",
                "Engine": "postgres",
                "MaxAllocatedStorage": 120,
                "VPCSecurityGroups": [{ "Fn::GetAtt": [Match.stringLikeRegexp("SimpleApiSGTSTestApi"), "GroupId"] }]
            })
        )
    })

    test("Should connect the migration custom resource", () => {
        const app = new App();

        const stack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: connectedApi.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                migrationLambda: "migration",
                dbProps: {
                    databaseName: "TestDatabase"
                }
            }
        );
        const template = Template.fromStack(stack)

        const customResource = template.findResources("Custom::PostgresDatabaseMigration", Match.anyValue())
        const resourceKeys = Object.keys(customResource)
        expect(resourceKeys.length).toEqual(1)
        expect(customResource[resourceKeys[0]].Properties.Checksum.length).toBeGreaterThan(0)
    })

    test("Different migration handlers should have different checksums", () => {
        const app = new App()
        const stack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: connectedApi.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                migrationLambda: "migration",
                dbProps: {
                    databaseName: "TestDatabase"
                }
            }
        );
        const template = Template.fromStack(stack)

        const app2 = new App()
        const stack2 = new TestStack(
            app2, "TestedStack2", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: connectedApi.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                migrationLambda: "migration",
                migrationLambdaPath: "/cruel",
                dbProps: {
                    databaseName: "TestDatabase"
                }
            }
        );
        const template2 = Template.fromStack(stack2)

        const customResource = template.findResources("Custom::PostgresDatabaseMigration", Match.anyValue())
        const customResource2 = template2.findResources("Custom::PostgresDatabaseMigration", Match.anyValue())
        const resourceKeys = Object.keys(customResource)
        const resourceKeys2 = Object.keys(customResource2)
        expect(customResource[resourceKeys[0]].Properties.Checksum)
            .not.toEqual(customResource2[resourceKeys2[0]].Properties.Checksum)
    })

    test("Should fail if the migration lambda is not found", async () => {
        const app = new App();

        expect(
            async () => new TestStack(
                app, "TestedStack", props,
                {
                    ...props,
                    apiName: "TSTestApi",
                    description: "Test Typescript API",
                    apiMetadata: connectedApi.metadata,
                    lambdaPath: "tests/lambda",
                    connectDatabase: true,
                    migrationLambda: "notFound",
                    dbProps: {
                        databaseName: "TestDatabase"
                    }
                }
            )
        ).rejects.toContainAllStrings("Handler not found")
    })

    test("Should fail if the migration lambda is empty", async () => {
        const app = new App();

        expect(
            async () => new TestStack(
                app, "TestedStack", props,
                {
                    ...props,
                    apiName: "TSTestApi",
                    description: "Test Typescript API",
                    apiMetadata: connectedApi.metadata,
                    lambdaPath: "tests/lambda",
                    connectDatabase: true,
                    migrationLambda: "wrong",
                    dbProps: {
                        databaseName: "TestDatabase"
                    }
                }
            )
        ).rejects.toContainAllStrings("No appropriate migration handler")
    })

    test("Should fail if the migration lambda is not a migration lambda", async () => {
        const app = new App();

        expect(
            async () => new TestStack(
                app, "TestedStack", props,
                {
                    ...props,
                    apiName: "TSTestApi",
                    description: "Test Typescript API",
                    apiMetadata: connectedApi.metadata,
                    lambdaPath: "tests/lambda",
                    connectDatabase: true,
                    migrationLambda: "meow",
                    dbProps: {
                        databaseName: "TestDatabase"
                    }
                }
            )
        ).rejects.toContainAllStrings("No appropriate migration handler")
    })
});
