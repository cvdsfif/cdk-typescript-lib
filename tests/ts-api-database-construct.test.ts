import { App, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApiDefinition } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiDatabaseProperties } from "../src/ts-api-construct";
import { Match, Template } from "aws-cdk-lib/assertions";
import { connectedApi } from "./lambda/shared/connected-api-definition";

describe("Testing a stack with connected database", () => {
    class TestStack<T extends ApiDefinition> extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiDatabaseProperties<T>,
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
                apiMetadata: connectedApi.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                databaseName: "TestDatabase"
            }
        );
        template = Template.fromStack(stack);
    });

    test("Should create a stack with connected database", () => {
        template.hasResourceProperties("AWS::RDS::DBInstance",
            Match.objectLike({
                "DBName": "TestDatabase",
                "Engine": "postgres",
                "VPCSecurityGroups": [{ "Fn::GetAtt": [Match.stringLikeRegexp("SimpleApiSGTSTestApi"), "GroupId"] }]
            })
        );
    })
});
