import { handlerImpl } from "typizator-handler";
import { simpleApiS } from "./shared/simple-api-definition";

export const helloWorldImpl = async (name: string, num: bigint) => `${num} greetings to ${name}`;
export const helloWorld = handlerImpl(
    simpleApiS.metadata.implementation.helloWorld,
    helloWorldImpl
);