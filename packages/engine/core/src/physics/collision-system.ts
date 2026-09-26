import { Stage, system } from "../ecs/system";
import type { World } from "../ecs/world";
import type { CollisionStartedEvent, CollisionStoppedEvent, ContactEvent, TriggerEnterEvent, TriggerExitEvent } from "./events";
import {
    COLLISION_STARTED_CHANNEL,
    COLLISION_STOPPED_CHANNEL,
    computeCollisionEvents,
    computeTriggerEvents,
    CONTACT_CHANNEL,
    TRIGGER_ENTER_CHANNEL,
    TRIGGER_EXIT_CHANNEL,
} from "./events";
import type { ContactManifold, IntersectionPair } from "./interface";
import type { PhysicsRealm } from "./realm";

export class CollisionEventSystem {
  private realm: PhysicsRealm;
  private world: World;
  private previousContacts: ContactManifold[] = [];
  private previousIntersections: IntersectionPair[] = [];

  constructor(world: World, realm: PhysicsRealm) {
    this.world = world;
    this.realm = realm;
  }

  setRealm(realm: PhysicsRealm): void {
    this.realm = realm;
    this.previousContacts = [];
    this.previousIntersections = [];
  }

  update(): void {
    const currentContacts = this.realm.getContacts();
    const { started, stopped, contacts } = computeCollisionEvents(currentContacts, this.previousContacts);

    const startedChannel = this.world.events.get<CollisionStartedEvent>(COLLISION_STARTED_CHANNEL);
    const stoppedChannel = this.world.events.get<CollisionStoppedEvent>(COLLISION_STOPPED_CHANNEL);
    const contactChannel = this.world.events.get<ContactEvent>(CONTACT_CHANNEL);

    started.forEach((event) => {
      startedChannel.send(event);
    });
    stopped.forEach((event) => {
      stoppedChannel.send(event);
    });
    contacts.forEach((event) => {
      contactChannel.send(event);
    });

    this.previousContacts = currentContacts;

    // Trigger (sensor) enter/exit events
    const currentIntersections = this.realm.getIntersections();
    const { entered, exited } = computeTriggerEvents(currentIntersections, this.previousIntersections);

    const enterChannel = this.world.events.get<TriggerEnterEvent>(TRIGGER_ENTER_CHANNEL);
    const exitChannel = this.world.events.get<TriggerExitEvent>(TRIGGER_EXIT_CHANNEL);

    entered.forEach((event) => {
      enterChannel.send(event);
    });
    exited.forEach((event) => {
      exitChannel.send(event);
    });

    this.previousIntersections = currentIntersections;
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
    this.previousIntersections = [];
    this.world.events.get<CollisionStartedEvent>(COLLISION_STARTED_CHANNEL).clear();
    this.world.events.get<CollisionStoppedEvent>(COLLISION_STOPPED_CHANNEL).clear();
    this.world.events.get<ContactEvent>(CONTACT_CHANNEL).clear();
    this.world.events.get<TriggerEnterEvent>(TRIGGER_ENTER_CHANNEL).clear();
    this.world.events.get<TriggerExitEvent>(TRIGGER_EXIT_CHANNEL).clear();
  }
}
