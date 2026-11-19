// Shapes shared by the workspace API and the screens.

export interface WsStock {
  id: number;
  name: string;
  nseSymbol: string | null;
  lastAceDate: string | null;
}

export interface WsTab {
  id: number;
  name: string;
  stockIds: number[];
}

export interface WsProfile {
  id: number;
  name: string;
  tabs: WsTab[];
}

export interface BinItem {
  binId: string;
  kind: "profile" | "tab" | "company" | "action" | "netDebt";
  label: string;
  /** Where it was, e.g. the profile a tab sat in. */
  from: string | null;
  removedAt: string;
  removedBy: string | null;
}

export interface Workspace {
  profiles: WsProfile[];
  stocks: WsStock[];
  bin: BinItem[];
  /** max(activity_log.id): changes whenever anyone writes. */
  version: number;
  lastChange: { id: number; profile: string | null; summary: string; at: string } | null;
}

/** Every edit the screens can make. `actor` is the profile selected in that browser. */
export type WorkspaceOp =
  | { op: "addProfile"; name: string }
  | { op: "renameProfile"; id: number; name: string }
  | { op: "removeProfile"; id: number }
  | { op: "duplicateProfile"; id: number }
  | { op: "reorderProfiles"; ids: number[] }
  | { op: "addTab"; profileId: number; name: string }
  | { op: "renameTab"; id: number; name: string }
  | { op: "removeTab"; id: number }
  | { op: "duplicateTab"; id: number }
  | { op: "moveTab"; id: number; profileId: number; copy: boolean }
  | { op: "reorderTabs"; profileId: number; ids: number[] }
  | { op: "addStock"; tabId: number; stockId: number }
  | { op: "removeStock"; tabId: number; stockId: number }
  | { op: "reorderStocks"; tabId: number; stockIds: number[] }
  | { op: "moveStock"; tabId: number; stockId: number; toTabId: number; copy: boolean }
  | { op: "restore"; binId: string };
