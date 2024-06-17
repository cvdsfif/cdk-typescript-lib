import { lambdaConnector } from "typizator-handler";
import { simpleApiS } from "./shared/simple-api-definition";

export const telegrafConnectedImpl = async () => { throw new Error("Pas de miaou"); }
export const telegrafConnected = lambdaConnector(
    simpleApiS.metadata.implementation.noMeow,
    telegrafConnectedImpl,
    {
        telegraf: true
    }
)