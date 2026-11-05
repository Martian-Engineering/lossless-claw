/** Only explicitly authored, content-free operational messages may reach chat. */
export class GapRepairError extends Error {
  constructor(message: string) { super(message); this.name = "GapRepairError"; }
}
