import type { World } from "../ecs/world.ts";
import type { PhysicsRealm } from "./realm.ts";
import type { ContactManifold } from "./interface.ts";
import {
  computeCollisionEvents,
  COLLISION_STARTED_CHANNEL,
  COLLISION_STOPPED_CHANNEL,
  CONTACT_CHANNEL,
} from "./events.ts";
import type { CollisionStartedEvent, CollisionStoppedEvent, ContactEvent } from "./events.ts";
import { system, Stage } from "../ecs/system.ts";

export class CollisionEventSystem {
  private realm: PhysicsRealm;
  private world: World;
  private previousContacts: ContactManifold[] = [];

  constructor(world: World, realm: PhysicsRealm) {
    this.world = world;
    this.realm = realm;
  }

  setRealm(realm: PhysicsRealm): void {
    this.realm = realm;
    this.previousContacts = [];
  }

  update(): void {
    const currentContacts = this.realm.getContacts();
    const { started, stopped, contacts } = computeCollisionEvents(currentContacts, this.previousContacts);

    const startedChannel = this.world.events.get<CollisionStartedEvent>(COLLISION_STARTED_CHANNEL);
    const stoppedChannel = this.world.events.get<CollisionStoppedEvent>(COLLISION_STOPPED_CHANNEL);
    const contactChannel = this.world.events.get<ContactEvent>(CONTACT_CHANNEL);

    for (const event of started) {
      startedChannel.send(event);
    }
    for (const event of stopped) {
      stoppedChannel.send(event);
    }
    for (const event of contacts) {
      contactChannel.send(event);
    }

    this.previousContacts = currentContacts;
  }

  register(): void {
    const self = this;
    const collisionSystem = system(
      "collision-events",
      Stage.PostUpdate,
      () => {
        self.update();
      },
    );
    this.world.schedule.add(collisionSystem);
  }

  clear(): void {
    this.previousContacts = [];
    this.world.events.get<CollisionStartedEvent>(COLLISION_STARTED_CHANNEL).clear();
    this.world.events.get<CollisionStoppedEvent>(COLLISION_STOPPED_CHANNEL).clear();
    this.world.events.get<ContactEvent>(CONTACT_CHANNEL).clear();
  }
}
