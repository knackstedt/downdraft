export type AuthorityLevel = "server" | "client" | "shared";

export interface EntityAuthority {
  entityId: number;
  ownerPeerId: string | null;
  authorityLevel: AuthorityLevel;
  locked: boolean;
}

export class AuthorityManager {
  private authorities: Map<number, EntityAuthority> = new Map();
  private localPeerId: string;
  private isServer: boolean;
  private authorityChangeCbs: Array<(entityId: number, authority: EntityAuthority) => void> = [];

  constructor(localPeerId: string, isServer: boolean) {
    this.localPeerId = localPeerId;
    this.isServer = isServer;
  }

  registerEntity(entityId: number, authorityLevel: AuthorityLevel = "server"): void {
    this.authorities.set(entityId, {
      entityId,
      ownerPeerId: authorityLevel === "client" ? this.localPeerId : null,
      authorityLevel,
      locked: false,
    });
  }

  unregisterEntity(entityId: number): void {
    this.authorities.delete(entityId);
  }

  requestAuthority(entityId: number, peerId: string): boolean {
    if (!this.isServer) return false;
    const auth = this.authorities.get(entityId);
    if (!auth) return false;
    if (auth.locked) return false;
    auth.ownerPeerId = peerId;
    auth.authorityLevel = "client";
    this.notifyChange(entityId, auth);
    return true;
  }

  grantAuthority(entityId: number, peerId: string): void {
    const auth = this.authorities.get(entityId);
    if (!auth) return;
    auth.ownerPeerId = peerId;
    auth.authorityLevel = "client";
    this.notifyChange(entityId, auth);
  }

  revokeAuthority(entityId: number): void {
    const auth = this.authorities.get(entityId);
    if (!auth) return;
    auth.ownerPeerId = null;
    auth.authorityLevel = "server";
    this.notifyChange(entityId, auth);
  }

  lockAuthority(entityId: number): void {
    const auth = this.authorities.get(entityId);
    if (!auth) return;
    auth.locked = true;
  }

  unlockAuthority(entityId: number): void {
    const auth = this.authorities.get(entityId);
    if (!auth) return;
    auth.locked = false;
  }

  hasAuthority(entityId: number): boolean {
    const auth = this.authorities.get(entityId);
    if (!auth) return false;
    if (this.isServer && auth.authorityLevel === "server") return true;
    if (auth.authorityLevel === "client" && auth.ownerPeerId === this.localPeerId) return true;
    if (auth.authorityLevel === "shared") return true;
    return false;
  }

  getAuthority(entityId: number): EntityAuthority | undefined {
    return this.authorities.get(entityId);
  }

  getOwnedEntities(): number[] {
    const result: number[] = [];
    for (const [entityId, auth] of this.authorities) {
      if (auth.ownerPeerId === this.localPeerId) {
        result.push(entityId);
      }
    }
    return result;
  }

  getServerEntities(): number[] {
    const result: number[] = [];
    for (const [entityId, auth] of this.authorities) {
      if (auth.authorityLevel === "server") {
        result.push(entityId);
      }
    }
    return result;
  }

  canModify(entityId: number): boolean {
    return this.hasAuthority(entityId);
  }

  onAuthorityChange(cb: (entityId: number, authority: EntityAuthority) => void): void {
    this.authorityChangeCbs.push(cb);
  }

  private notifyChange(entityId: number, auth: EntityAuthority): void {
    this.authorityChangeCbs.forEach((cb) => cb(entityId, auth));
  }

  setLocalPeerId(peerId: string): void {
    this.localPeerId = peerId;
  }
}
