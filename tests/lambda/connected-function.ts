import { HandlerProps, lambdaConnector } from "typizator-handler";
import { connectedApi } from "./shared/connected-api-definition";

export const connectedFunction = lambdaConnector(
    connectedApi.metadata.implementation.connectedFunction,
    async (props: HandlerProps) => { },
    { databaseConnected: true }
);

