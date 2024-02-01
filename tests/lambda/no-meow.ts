import { handlerImpl } from "typizator-handler";
import { simpleApiS } from "./shared/simple-api-definition";

export const noMeowImpl = async () => { throw new Error("Pas de miaou"); }
export const noMeow = handlerImpl(
    simpleApiS.metadata.implementation.noMeow,
    noMeowImpl
);