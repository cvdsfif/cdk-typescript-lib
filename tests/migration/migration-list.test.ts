import { migrationList } from "../../src/migration/migration-list"

describe("Testing the events lists for migrations", () => {
    test("List with no arguments should return empty migration list", () => {
        expect(migrationList().length).toEqual(0)
    })

    test("List with three elements is correctly creates", () => {
        const threeMigrationsList = migrationList()
            .migrate({
                order: 1,
                description: "D1",
                query: "Q1"
            })
            .migrate({
                order: 2,
                description: "D2",
                query: "Q2"
            })
            .migrate({
                order: 3,
                description: "D3",
                query: "Q3"
            })
        expect(threeMigrationsList.length).toEqual(3)
        expect(threeMigrationsList[0].order).toEqual(1)
        expect(threeMigrationsList[1].description).toEqual("D2")
        expect(threeMigrationsList[2].query).toEqual("Q3")
    })

    test("Zero or negative migration order numbers should be forbidden", () => {
        expect(() => migrationList().migrate({ order: 0, description: "D", query: "1" }))
            .toThrow("Migration order number must be greater than zero");
        expect(() => migrationList().migrate({ order: -100, description: "D", query: "1" }))
            .toThrow("Migration order number must be greater than zero");
    })

    test("Migration numbers should never decrease", () => {
        expect(() => migrationList()
            .migrate({ order: 10, description: "D", query: "1" })
            .migrate({ order: 9, description: "D", query: "1" })
        ).toThrow("Migration orders must grow, migration 9 cannot go after migration 10")
    })
})