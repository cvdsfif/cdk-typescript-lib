import { handlerImpl } from "typizator-handler";
import { simpleApiS } from "./../shared/simple-api-definition";

export const cruelWorldImpl = async (val: string) => `Goodbye, cruel ${val}`;
export const world = handlerImpl(
    simpleApiS.metadata.implementation.cruel.world,
    cruelWorldImpl
);