import { apiS, bigintS, stringS } from "typizator";

export const simpleApiS = apiS({
    meow: { args: [], retVal: stringS.notNull },
    noMeow: { args: [] },
    helloWorld: { args: [stringS.notNull, bigintS.notNull], retVal: stringS.notNull },
    cruel: {
        world: { args: [stringS.notNull], retVal: stringS.notNull }
    }
});