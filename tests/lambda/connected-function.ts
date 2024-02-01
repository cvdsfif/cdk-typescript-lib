import { HandlerProps, connectedHandlerImpl } from "typizator-handler";
import { connectedApi } from "./shared/connected-api-definition";

export const connectedFunction = connectedHandlerImpl(
    connectedApi.metadata.implementation.connectedFunction,
    async (props: HandlerProps) => { }
);

