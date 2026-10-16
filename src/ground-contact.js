import { Quaternion, Vector3 } from 'three';
import { Body, Box, ContactMaterial, Cylinder, Material, Plane, Quaternion as CannonQuaternion, RigidVehicle, Vec3, World } from 'cannon-es';

// The render origin is the car bottom. A low battery-floor COM and independent
// hinged tyres let a tilted car land wheel by wheel without an upright assist.
export const CONTACT_BODY = Object.freeze({ width: 2.1, length: 4.7, height: 1.2, centreHeight: 0.32, underside: 0.18 });
export const CONTACT_WHEELS = Object.freeze([
  { name: 'front-left', x: 0.94, y: 0.35, z: 1.215, radius: 0.35 },
  { name: 'front-right', x: -0.94, y: 0.35, z: 1.215, radius: 0.35 },
  { name: 'rear-left', x: 0.94, y: 0.4, z: -1.64, radius: 0.4 },
  { name: 'rear-right', x: -0.94, y: 0.4, z: -1.64, radius: 0.4 },
].map(Object.freeze));
const WHEEL_WIDTH = 0.216;
const WHEEL_SEGMENTS = 48;
const HALF_WIDTH = CONTACT_BODY.width / 2;
const HALF_LENGTH = CONTACT_BODY.length / 2;
const BODY_POINTS = [-HALF_WIDTH, HALF_WIDTH].flatMap((x) => [CONTACT_BODY.underside, CONTACT_BODY.height]
  .flatMap((y) => [-HALF_LENGTH, HALF_LENGTH].map((z) => new Vector3(x, y, z))));
const WHEEL_POINTS = CONTACT_WHEELS.flatMap((wheel) => [-1, 1].flatMap((side) => Array.from({ length: 24 }, (_, index) => {
  const angle = index * 2 * Math.PI / 24;
  return new Vector3(wheel.x + side * WHEEL_WIDTH / 2, wheel.y + wheel.radius * Math.cos(angle), wheel.z + wheel.radius * Math.sin(angle));
})));
const SUPPORT_POINTS = [...BODY_POINTS, ...WHEEL_POINTS];
const sessions = new WeakMap();
const attitudeOf = (state) => new Quaternion(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);

/** World metres: signed floor clearance and the body/tyre collision envelope. */
export function groundSupport(state) {
  const attitude = attitudeOf(state);
  const origin = new Vector3(state.pos.x, state.pos.y, state.pos.z);
  const points = SUPPORT_POINTS.map((point) => point.clone().applyQuaternion(attitude).add(origin));
  return {
    minimumY: Math.min(...points.map((point) => point.y)),
    minimumX: Math.min(...points.map((point) => point.x)),
    maximumX: Math.max(...points.map((point) => point.x)),
    minimumZ: Math.min(...points.map((point) => point.z)),
    maximumZ: Math.max(...points.map((point) => point.z)),
  };
}

function writeState(state, session) {
  const { chassis } = session;
  const q = chassis.quaternion;
  state.orientation = { x: q.x, y: q.y, z: q.z, w: q.w };
  const offset = q.vmult(new Vec3(0, CONTACT_BODY.centreHeight, 0));
  state.pos = { x: chassis.position.x - offset.x, y: chassis.position.y - offset.y, z: chassis.position.z - offset.z };
  state.vel = { x: chassis.velocity.x, y: chassis.velocity.y, z: chassis.velocity.z };
  const localAngular = q.conjugate().vmult(chassis.angularVelocity);
  state.angular = { pitch: -localAngular.x, yaw: localAngular.y, roll: -localAngular.z };
}

/** Per-car synchronous world stays outside serializable UI/telemetry state. */
export function beginGroundContact(state, gravity) {
  const world = new World({ gravity: new Vec3(0, -gravity, 0), allowSleep: false });
  world.solver.iterations = 32;
  world.solver.tolerance = 1e-8;
  const floorMaterial = new Material('ground');
  const tyreMaterial = new Material('tyre');
  const bodyMaterial = new Material('body');
  world.addContactMaterial(new ContactMaterial(floorMaterial, tyreMaterial, {
    friction: 0.65, restitution: 0.24, contactEquationStiffness: 5e7, contactEquationRelaxation: 4,
  }));
  world.addContactMaterial(new ContactMaterial(floorMaterial, bodyMaterial, {
    friction: 0.55, restitution: 0.12, contactEquationStiffness: 5e7, contactEquationRelaxation: 4,
  }));
  const floor = new Body({ mass: 0, material: floorMaterial });
  floor.addShape(new Plane());
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floor);
  const chassis = new Body({ mass: 1120, material: bodyMaterial, linearDamping: 0.12, angularDamping: 0.42 });
  const bodyHeight = CONTACT_BODY.height - CONTACT_BODY.underside;
  chassis.addShape(new Box(new Vec3(HALF_WIDTH, bodyHeight / 2, HALF_LENGTH)),
    new Vec3(0, CONTACT_BODY.underside + bodyHeight / 2 - CONTACT_BODY.centreHeight, 0));
  chassis.quaternion.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);
  chassis.quaternion.normalize();
  const offset = chassis.quaternion.vmult(new Vec3(0, CONTACT_BODY.centreHeight, 0));
  chassis.position.set(state.pos.x + offset.x, state.pos.y + offset.y, state.pos.z + offset.z);
  chassis.velocity.set(state.vel.x, state.vel.y, state.vel.z);
  chassis.quaternion.vmult(new Vec3(-state.angular.pitch, state.angular.yaw ?? 0, -state.angular.roll), chassis.angularVelocity);
  const vehicle = new RigidVehicle({ chassisBody: chassis });
  const cylinderRotation = new CannonQuaternion().setFromEuler(0, 0, Math.PI / 2);
  for (const specification of CONTACT_WHEELS) {
    const wheel = new Body({ mass: 20, material: tyreMaterial, linearDamping: 0.12, angularDamping: 0.03 });
    wheel.addShape(new Cylinder(specification.radius, specification.radius, WHEEL_WIDTH, WHEEL_SEGMENTS), Vec3.ZERO, cylinderRotation);
    wheel.quaternion.copy(chassis.quaternion);
    vehicle.addWheel({ body: wheel, position: new Vec3(specification.x, specification.y - CONTACT_BODY.centreHeight, specification.z), axis: new Vec3(1, 0, 0) });
    wheel.velocity.copy(chassis.velocity);
    const forward = chassis.quaternion.vmult(new Vec3(0, 0, 1));
    const spin = chassis.velocity.dot(forward) / specification.radius;
    chassis.quaternion.vmult(new Vec3(spin, 0, 0), wheel.angularVelocity);
    wheel.angularVelocity.vadd(chassis.angularVelocity, wheel.angularVelocity);
  }
  vehicle.addToWorld(world);
  const session = { world, chassis, vehicle, floor };
  sessions.set(state, session);
  // Only remove time-of-impact overshoot; preserve velocity for the engine's
  // restitution and preserve attitude for natural wheel/body contacts.
  const correction = Math.max(0, -groundSupport(state).minimumY + 0.001);
  for (const body of [chassis, ...vehicle.wheelBodies]) body.position.y += correction;
  writeState(state, session);
}

/** Ordinary constrained rigid-body step, with no angle target or pose reset. */
export function stepGroundContact(state, dt, gravity) {
  if (!sessions.has(state)) beginGroundContact(state, gravity);
  const session = sessions.get(state);
  const { world, chassis, vehicle, floor } = session;
  let normalImpulse = 0;
  let impactSpeed = 0;
  const wheels = new Set();
  let grounded = false;
  const substeps = Math.max(1, Math.ceil(dt / (1 / 360)));
  for (let index = 0; index < substeps; index += 1) {
    const upright = chassis.quaternion.vmult(new Vec3(0, 1, 0)).y > 0.75;
    if ((state.contact.wheels.length >= 3 || wheels.size >= 3) && upright) {
      // Apply tyre rolling/braking resistance on every engine substep, not
      // just once per rendered frame. All deceleration goes through dynamics.
      for (const wheel of vehicle.wheelBodies) {
        const axis = chassis.quaternion.vmult(new Vec3(1, 0, 0));
        const spin = wheel.angularVelocity.dot(axis);
        wheel.applyTorque(axis.scale(Math.min(90, Math.abs(spin) * 14) * -Math.sign(spin)));
      }
    }
    world.step(dt / substeps);
    for (const contact of world.contacts) {
      if (contact.bi !== floor && contact.bj !== floor) continue;
      grounded = true;
      normalImpulse += Math.max(0, contact.multiplier) * dt / substeps / 1200;
      impactSpeed = Math.max(impactSpeed, Math.abs(contact.getImpactVelocityAlongNormal()));
      const movingBody = contact.bi === floor ? contact.bj : contact.bi;
      const wheelIndex = vehicle.wheelBodies.indexOf(movingBody);
      if (wheelIndex >= 0) wheels.add(wheelIndex);
    }
  }
  writeState(state, session);
  // Bound finite-step solver penetration to 3 mm by translating the complete
  // assembly, never by flattening the attitude or clamping the origin to zero.
  const minimumY = groundSupport(state).minimumY;
  if (minimumY < -0.003) {
    const correction = -minimumY - 0.003;
    for (const body of [chassis, ...vehicle.wheelBodies]) body.position.y += correction;
    writeState(state, session);
  }
  const forward = chassis.quaternion.vmult(new Vec3(0, 0, 1));
  // Constraint/contact solvers can alternate an almost resting tyre between
  // touching and a millimetre of clearance. Include that support tolerance in
  // telemetry/sleep detection, without altering any physical force or pose.
  const axle = chassis.quaternion.vmult(new Vec3(1, 0, 0));
  for (let index = 0; index < vehicle.wheelBodies.length; index += 1) {
    const wheel = vehicle.wheelBodies[index];
    const radius = CONTACT_WHEELS[index].radius;
    const clearance = wheel.position.y - radius * Math.sqrt(Math.max(0, 1 - axle.y ** 2)) - WHEEL_WIDTH / 2 * Math.abs(axle.y);
    if (clearance < 0.012 && Math.abs(wheel.velocity.y) < 0.35) wheels.add(index);
  }
  grounded ||= wheels.size > 0;
  return { grounded, normalImpulse, impactSpeed, wheels: [...wheels], forwardSpeed: chassis.velocity.dot(forward) };
}
