import { createContext, useContext } from "react";
import type { HostTransport } from "@fleet-console/sdk/host-context";

/** renderer가 읽는 자산·identity의 주입 경계. 부재는 기존 로컬 표면이다. */
const Context = createContext<HostTransport | null>(null);
export const ChatHostProvider = Context.Provider;
export function useChatHost(): HostTransport | null { return useContext(Context); }
