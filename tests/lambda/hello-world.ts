import { HandlerProps, lambdaConnector } from "typizator-handler";
import { simpleApiS } from "./shared/simple-api-definition";

export const helloWorldImpl = async (_: HandlerProps, name: string, num: bigint) => `${num} greetings to ${name}`;
export const helloWorld = lambdaConnector(
    simpleApiS.metadata.implementation.helloWorld,
    helloWorldImpl
);