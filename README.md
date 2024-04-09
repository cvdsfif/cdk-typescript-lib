# Runtime types and metadata schemas for Typescript 

![Coverage](./badges/coverage.svg) [![npm version](https://badge.fury.io/js/cdk-typescript-lib.svg)](https://badge.fury.io/js/cdk-typescript-lib) [![Node version](https://img.shields.io/node/v/cdk-typescript-lib.svg?style=flat)](https://nodejs.org/)

## Purpose

Automate AWS lambdas creation to implement an API interface written in Typescript. Allows to create and incrementally migrate database schemas.

## Installing

```Bash
npm i cdk-typescript-lib
```

## Documentation

> There is a tutorial explaining in details how to use this library and to connect it to the web client [here](https://medium.com/@cvds.eu/typescript-api-implementing-with-aws-cdk-and-using-on-a-web-client-2e3fe55a2f7b?sk=7f56e4bae87f46f4d774220d2f6ea95d)

### Single CDK stack API implementation

Let's imagine a very simple two-methods API to implement, defined as `typizator` schema:

```ts
const api = apiS({
    helloWorld: {
        args: [stringS.notNull], retVal: stringS.notNull
    },
    subGroup: {
        report: { args:[] }
    }
})
```

We want on our CDK stack a structure that will create a slot for the implementation of this API in as many lambdas as there are methods in the API. Just two in this case. It will automatically be connected to the external world with an AWS HTTP API endpoint that we'll be able to connect from the client through the [typizator-client](https://www.npmjs.com/package/typizator-client) library.

We create it in a CDK stack:

```ts
class TestStack<T extends ApiDefinition> extends Stack {
    constructor(
        scope: Construct,
        id: string,
        props: StackProps
    ) {
        super(scope, id, props)
        // This is the construct from our library connecting
        const stack = new TSApiConstruct(
            this, 
            "TestApi", 
            {
                // We eventually inherit properties from the parent stack
                ...props,
                // We name the API
                apiName: "TSTestApi",
                // We describe it to those who will read this code after us
                description: "Test Typescript API",
                // This is THE KEY POINT: we pass our API schema to the construct.
                // And it build the implementation structure behind automatically.
                apiMetadata: api.metadata,
                // The folder in the root of your project where you put the Typescript implementations of your API methods
                lambdaPath: "lambda",
                // We don't connect to a database (yet)
                connectDatabase: false,
                // Here we define the properties for all the lambdas implementing our API. This is the shared configuration point
                lambdaProps: {
                    environment: {
                        ENV1: "a"
                    }
                },
                // And what if we want to define different props for different API's methods
                // It mimics the structure of your API, but all the entries are optional
                lambdaPropertiesTree: {
                    subGroup: {
                        // Here, we limit the access to subGroup and all its children to the 10.0.0.1 IP address
                        authorizedIps: ["10.0.0.1"],
                        report: {
                            // Here, we add the binary access mask to the report context.
                            // It can be checked before each execution through the authentication function
                            // passed to the lambda handler that implements that API function
                            accessMask: 0b1000,
                            // For example, we can schedule the function to run every minutes on the AWS cloud
                            schedules: [{
                                cron: { minute: "0/1" }
                            }]
                        }
                    }
                }
            })

        new CfnOutput(this, `ApiURL`, { value: stack.httpApi.url! })
    }
}
```

Now, how do we implement the API's functions? Very simple, we place the corresponding _.ts_ files in the directory defined by `lambdaPath`. The names of the files will be the same as in the API definition, but in _kebab-case_. In our case, we'll have to Typescript files:

- `hello-world.ts`
and
- `sub-group/report.ts`

In each of those files, we must export an implementing function with the same name as the file name, but in _camelCase_:

```ts
// hello-world.ts
import { handlerImpl } from "typizator-handler";
import { api } from "........";

export const helloWorldImpl = async (arg: string) : Promise<string> => {
    // Your implementation here
}

// This name must match the API definition
export const helloWorld = handlerImpl(
    api.metadata.implementation.helloWorld,
    // The name can be whatever you want, but the method signature must match the API definition
    helloWorldImpl
)
```

...and:

```ts
// sub-group/report.ts
import { handlerImpl } from "typizator-handler";
import { api } from "........";

export const reportImpl = async () : Promise<void> => {
    // Your implementation here
}

// This name must match the API definition
export const report = handlerImpl(
    api.metadata.implementation.report,
    // The name can be whatever you want, but the method signature must match the API definition
    reportImpl
)
```

We will need the connection point to our API to use it from outside. It is very simple, remember the `CfnOutput` at the end of the example stack above? It will print the URL of your API at the end of your next CDK deployment. Just copy it and use it. It will not change after the next deployments.

The construct automatically creates a layer in the `shared-layer` subdirectory of your `lambda` directory (you can change this via the construct's props). Put there all the stuff you need to share between all the API's lambdas, first of all the heavy-weight libraries that you don't need to bundle. Don't forget to list them in the `extraBundling.externalModules` property of your construct configuration, it's good to share things, but it's also good to let the compiler know about it...

That's it, your first implementation is done, you can deploy it with CDK and start to use it via the HTTP API.

### Adding a database

This is very simple. You just have to change the `connectDatabase` parameter in the stake definition above to `true` and add `dbProps:databaseName` to name your database, that's it.

You'll have to slightly change your handlers:

```ts
// hello-world.ts
import { HandlerProps, connectedHandlerImpl } from "typizator-handler";
import { api } from "........";

// When you use connectedHandlerImpl, the extra first parameter of the implementation becomes props, that contains the connected database object
export const helloWorldImpl = async (props: HandlerProps, arg: string) : Promise<string> => {
    // Your implementation here
}

// This name must match the API definition
export const helloWorld = connectedHandlerImpl(
    api.metadata.implementation.helloWorld,
    // The name can be whatever you want, but the method signature must match the API definition
    helloWorldImpl
)
```

When your implementation is called, `props.db` will contain the `ConnectedDatabase` facade to the Postgres database instance that the construct is creating for you on AWS RDS.

#### Bastion access

Sometimes you need to manually access your database through a terminal. This is possible by setting up a "Bastion" linux instance that will be the only point to have direct access to the database's IP port (**5432** in case of Postgresql). To set it up, simply add a `bastion` config parameter to the construct's props with, as a value, the list of IP networks that can access it from outside. For example, to open the access to _200.100.50.25_ only, add `bastion:{ openTo: "200.100.50.25/32" }.

Then you'll need to create an SSH key, then to install it on your Bastion by executing the following:

```bash
aws ec2-instance-connect send-ssh-public-key --instance-id {created bastion instance id} --instance-os-user ec2-user --ssh-public-key=file://~/.ssh/{your public key name}.pub
```

All that is about manual operations, so use the AWS console to locate all the needed addresses and identifiers.

Then on a machine where you want to access your database, create a tunnel (let's imagine you open the tunnel on the port **5446**):

```bash
ssh -i ./{your private key} -f -N -L 5446:{RDS database URL}:5432 ec2-user@{Bastion server address} -v
```

Then, you're free to connect the Postgresql terminal:

```bash
psql -h 127.0.0.1 -p 5446 -U postgres {Your database name}
```

### Migrating a data schema

It's good to create an empty database, but in a test-driven environment it would be also good to populate it at least with some tables and indexes. And later, change this schema following the development of your project. This is where the migration tool comes to help us.

The construct lets you create a special lambda that is deployed and executed during the CDK deployment as a custom component connected to the created database and executes what you require on this database every time this lambda's contents are changes.

I implemented a simple list-base forward-only migration tool that you can connect through the construct's properties. For that, you have to add to your configuration the `migrationLambda` property with the name of the lambda that fill do the job. For example `migrationLambda:"migration"`.

Then you have to create in your project's `lambda` folder (this name can be changed by setting an appropriate property) a typescript file named `migration.ts` (as per the configuration above) containing something like this:

```ts
const migrations = migrationList()
      .migration({
          order: 1,
          description: "Create first table",
          query: "CREATE TABLE tab1(id INTEGER)"
      })
      .migration({
          order: 2,
          description: "Create second table",
          query: "CREATE TABLE tab2(id INTEGER)"
      })

export const migration = postgresListMigrationHandler(migrations)
```

This will create in your database two tables `tab1` and `tab2`. Then, if you want to add something more, simply add other `.migration` records to your list. Once the project deployed with CDK, don't change the existing migration steps, they become immutable, rather add new steps changing the results of the existing ones.

### Splitting stacks

With a relatively big API, you'll hit sooner or later the AWS Cloudformation's limit of 500 deployed resources per stack. For that case, the library offers a possibility to split your API into several sub-APIs, each one deployed through its own stack and using its own HTTP API entry point.

First, you exclude a part of the API from the main constructs. Remember the API we did earlier:

```ts
const api = apiS({
    helloWorld: {
        args: [stringS.notNull], retVal: stringS.notNull
    },
    subGroup: {
        report: { args:[] }
    }
})
```

Let's move the subGroup to a different construct.

In our main construct's properties, we add:

```ts
apiExclusions: [
    api.metadata.implementation.subGroup.path
]
```

Then we can create (on a different stack) a new construct that will inherit (via the properties of the main stack) the access to all the resources for the new sub-api:

```ts
// We use DependentApiConstruct from this library
const childConstruct = new DependentApiConstruct(this, "ChildApi", {
    ...otherOptionalProps,
    apiName: "TSDependentTestApi",
    description: "Dependent typescript API",
    apiMetadata: api.metadata.implementation.subGroup,
    lambdaPath: "lambda", // You can change this for another directory if you want
    // Your parent construct must be inside its own stack in inherit the information on its components, including the database connection
    parentConstruct: parentStack.construct
})
```

The directory structure for the dependent stack's lambdas stay the same, i.e. our `report` lambda will live in `lambda/sub-group/report.ts`.

You can get the URL to access your child API by putting at the end of your child stack constructor the following:

```ts
new CfnOutput(this, `ChildApiURL`, { value: childConstruct.httpApi.url! })
```

The [typizator-client](https://www.npmjs.com/package/typizator-client) already includes the tools to integrate child APIs, refer to its documentation for details.

### Attaching the API to a custom domain

If you want to use your API on a domain name that belongs to you and in general to use something more readable than a long Amazon default domain name, you have an easy option for that with this library. But first, you need to have your domain hosted on AWS Route 53. You've probably already done it manually for a while, now your task is to create a subdomain and make it point to your API.

For that, in the properties of your construct you have to add the following property:

```ts
apiDomainData: {
    hostedZoneName: "yourdomain.com",
    domainNamePrefix: "api-endpoint"
}
```

This will create the `api-endpoint.yourdomain.com` name, create a certificate for it and let you query it with an HTTPS enpoint. The `apiUrl` property of your construct will point in that case to this endpoint, the `httpApi.url` stays available and points to the long and ugly URL from Amazon.

The only problem of this construction is that CDK will expect that your hosted zone name is available on the same AWS account that is used to deploy your CDK stack. It means that during the tests it will try to access this domain which is only possible in a full integration testing context, which is too heavy most of the times.

To solve it, you have to add for your tests the mock version of the domain lookup that will not try to go to the real Route 53 to try managing the domain. For that, the library has a special mock that could be added, on the test version of the stack only, as an extra property for the domain data:

```ts
apiDomainData: {
    hostedZoneName: "yourdomain.com",
    domainNamePrefix: "api-endpoint",
    customDomainLookup: customDomainLookupMock
}
```

That done, your tests will pass.

The other issue is that to work with Route 53 your stack will need to know your AWS account and main region. Let's imagine your main AWS hosting is in London. In that case, you have to add to the properties of your stack something like this:

```ts
env: {
    account: "<Your AWS account ID>",
    region: "eu-west-2"
}
```

The problem is that if at that moment you already have a database deployed on the stack (and thus a VPC attached to it), it can disturb your VPC's routing table. To avoid it, you have to explicitly set your VPC's availability zones to those you can find if you look at your VPC configuration in the AWS console. In our "London" case, we have to add to the construct's config the following:

```ts
vpcProps: {
    natGateways: 1,
    availabilityZones: ["eu-west-2a", "eu-west-2b"]
}
```

## Testing

We never test the framework. So once your construct configured, you can consider that it should work as expected. You just need to make sure that the construction passes and there is something on the resulting stack.

```ts
test("The template should sythetize properly", () => {
    const app = new App();
    const stack = new YourStackName(app, "UniqueStackId", {
        deployFor: "test"
    })
    const template = Template.fromStack(stack)
    // For example, we check that we have the common shared layer on our deployment
    const layers = template.findResources("AWS::Lambda::LayerVersion")
    expect(Object.keys(layers).length).toEqual(1)
})
```

After that, individually test the implementations of your components. You don't need to test the handlers themselves, it's a part of the framework, if the construct passes the test above, you can consider that they are properly connected.

My recommendation for the connected lambdas is to use a local Postgres instance, as explained in the documentation of [typizator-handler](https://www.npmjs.com/package/typizator-handler) and execute your migration every time you run your tests, this usually doesn't take a lot of time on the empty database. Use something like that to set up the connection:

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { MigrationResultFailure, MigrationResultSuccess, PostgresListMigrationProcessor } from "cdk-typescript-lib";
import { Client } from "pg";
import { DatabaseConnection, connectDatabase } from "typizator-handler";
import { migrations } from "<Path to your migration lambda>";

const isMigrationResultFailure = (
    arg: MigrationResultSuccess | MigrationResultFailure
): arg is MigrationResultFailure => !((arg as MigrationResultFailure).successful)

export const setupTestConnection = (runFirst = async (_: DatabaseConnection) => { }) => {
    jest.setTimeout(60000);
    const setup = {
        connection: null as (DatabaseConnection | null)
    }

    beforeAll(async () => {
        const container = await new PostgreSqlContainer().withReuse().start()
        const client = new Client({ connectionString: container.getConnectionUri() })
        await client.connect()
        setup.connection = connectDatabase(client)
        await runFirst(setup.connection)
        const migration = new PostgresListMigrationProcessor(migrations, { allowMigrationContentsChanges: true })
        await migration.initialize(setup.connection)
        const migrationResult = await migration.migrate(setup.connection)
        if (isMigrationResultFailure(migrationResult))
            throw new Error(`Migration failed: ${migrationResult.errorMessage}`)
    })

    afterAll(async () => await setup.connection!.client.end())

    return setup
}
```

Using `.withReuse` with the Postgres container economises the tests execution time, but can break a bit your test sandboxes cleanliness. To make sure that things are always clean in your test suites, create global setup and teardown procedures for jest, adding to _jest.config.js_ the following lines: 

```js
    globalSetup: '<rootDir>/tests/globalSetup.ts',
    globalTeardown: '<rootDir>/tests/globalTeardown.ts'
```

Then, do the necessary cleanup:

```ts
// globalSetup.ts

import { connectDatabase } from "typizator-handler"
import { objectS, stringS } from "typizator"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"

export default async function setup() {
    console.log("Running global setup...")
    const container = await new PostgreSqlContainer().withReuse().start()
    const client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    const connection = connectDatabase(client)

    const allTables = await connection.typedQuery(
        objectS({ tablename: stringS }), 
        "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
    )
    for (const table of allTables) {
        await connection.query(`DROP TABLE IF EXISTS ${table.tablename} CASCADE`)
    }
    (globalThis as any).connection = connection
    console.log("Done")
}
```

...and

```ts
// globalTeardown.ts

import { DatabaseConnection } from "typizator-handler";

export default async function teardown() {
    await ((globalThis as any).connection as DatabaseConnection).client.end()
    console.log("Global teardown done")
}
```