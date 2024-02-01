import { handlerImpl } from "typizator-handler";
import { simpleApiS } from "./shared/simple-api-definition";

export const meowImpl = async () => "Miaou";
export const meow = handlerImpl(
    simpleApiS.metadata.implementation.meow,
    meowImpl
);