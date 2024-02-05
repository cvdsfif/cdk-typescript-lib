import { Client } from "pg"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { DatabaseConnection, connectDatabase } from "typizator-handler"
import { MigrationProcessor } from "../../src/migration/migration-handler"
import { PostgresListMigrationProcessor, databaseMigrationSchema } from "../../src/migration/postgres/postgres-list-migration-processor";
import { migrationList } from "../../src/migration/migration-list";
import { extendExpectWithToContainStrings } from "../util/expect-contain-strings";

describe("Testing the migration tool for Postgres using a forward-only migrations list", () => {
    extendExpectWithToContainStrings()
    jest.setTimeout(60000)

    let connection: DatabaseConnection
    let underTest: MigrationProcessor
    const basicMigrationList = migrationList()
        .migrate({
            order: 1,
            description: "M1",
            query: "CREATE TABLE test_table(id INTEGER,name TEXT)"
        })
        .migrate({
            order: 2,
            description: "M2",
            query: "INSERT INTO test_table VALUES(1,'one')"
        })

    beforeAll(async () => {
        const container = await new PostgreSqlContainer().withReuse().start()
        const client = new Client({ connectionString: container.getConnectionUri() })
        client.connect()
        connection = connectDatabase(client);
        underTest = new PostgresListMigrationProcessor(basicMigrationList)
    })

    afterAll(async () => await connection.client.end())

    afterEach(async () => {
        await connection.query(`DROP TABLE IF EXISTS ${underTest.migrationTableName}`)
        await connection.query(`DROP TABLE IF EXISTS test_table`)
    })



    test("Should create the migration table", async () => {
        await underTest.initialize(connection)
        expect(await connection.select(databaseMigrationSchema, underTest.migrationTableName))
            .toEqual([])
    })

    test("Should do a simple forward-only migration", async () => {
        await underTest.initialize(connection)
        await underTest.migrate(connection)
        expect((await connection.select(databaseMigrationSchema, underTest.migrationTableName)).length)
            .toEqual(2)
    })

    test("Should report an error on database exception", async () => {
        const localMigration = new PostgresListMigrationProcessor(
            migrationList()
                .migrate({
                    order: 1,
                    description: "M1",
                    query: "You cannot execute this"
                })
        )
        await localMigration.initialize(connection)
        const result = await localMigration.migrate(connection)
        expect(result.successful).toEqual(false)
        const errorMessage = "syntax error at or near \"You\"";
        if (!result.successful)
            expect(result.errorMessage).toEqual(errorMessage)
        expect(
            (await connection.select(
                databaseMigrationSchema,
                `${underTest.migrationTableName} WHERE successful=false`)
            )[0].message
        ).toEqual(errorMessage)
    })

    test("Should continue after successful migration", async () => {
        await underTest.initialize(connection)
        await underTest.migrate(connection)

        const localMigration = new PostgresListMigrationProcessor(
            basicMigrationList
                .migrate({
                    order: 3,
                    description: "M3",
                    query: "UPDATE test_table SET name='two'"
                })
        )
        await localMigration.migrate(connection)
        expect((await connection.select(databaseMigrationSchema, underTest.migrationTableName)).length)
            .toEqual(3)
    })

    test("Should recover after failed migration", async () => {
        let localMigration = new PostgresListMigrationProcessor(
            migrationList()
                .migrate({
                    order: 1,
                    description: "M1",
                    query: "You cannot execute this"
                })
        )
        await localMigration.initialize(connection)
        let result = await localMigration.migrate(connection)

        localMigration = new PostgresListMigrationProcessor(basicMigrationList);
        result = await localMigration.migrate(connection)
        expect(result.successful).toEqual(true)
        expect(result.lastSuccessful).toEqual(2)
    })

    test("Should report changed migration", async () => {
        await underTest.initialize(connection)
        await underTest.migrate(connection)

        const localMigration = new PostgresListMigrationProcessor(
            migrationList()
                .migrate({
                    order: 1,
                    description: "M1",
                    query: "CREATE TABLE test_table(id INTEGER,name TEXT)"
                })
                .migrate({
                    order: 2,
                    description: "M2",
                    query: "We try to change it"
                })
                .migrate({
                    order: 3,
                    description: "M3",
                    query: "UPDATE test_table SET name='two'"
                })
        )
        expect(async () => await localMigration.migrate(connection)).rejects
            .toContainAllStrings("query text modified")
    })

    test("Should report removed migration", async () => {
        await underTest.initialize(connection)
        await underTest.migrate(connection)

        const localMigration = new PostgresListMigrationProcessor(
            migrationList()
                .migrate({
                    order: 1,
                    description: "M1",
                    query: "CREATE TABLE test_table(id INTEGER,name TEXT)"
                })
                // We try to remove a migration that is already in the database
                .migrate({
                    order: 3,
                    description: "M3",
                    query: "UPDATE test_table SET name='two'"
                })
        )
        expect(async () => await localMigration.migrate(connection)).rejects
            .toContainAllStrings("not found in your list")
    })
})