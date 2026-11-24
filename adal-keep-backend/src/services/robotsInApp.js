/**
 * Robots run in their own program, "Adal Robots" (the owner, 2026-11-24: "remove the robots from
 * Adal Keep, keep the older version, and make the robots work as fast as possible"). Adal Keep
 * itself then claims and runs no robot job, starts and connects to no robot browser (no Adal
 * Browser, no port 9222), keeps no sign-ins, queues nothing by itself: a robot button puts the
 * job "in line for Adal Robots" (automation_queue, docs/robot-queue.md).
 * ADAL_ROBOTS_IN_APP=1 brings the robots back inside Adal Keep, as before.
 */
export const robotsInApp = () => process.env.ADAL_ROBOTS_IN_APP === '1'
export const IN_LINE = 'In line for Adal Robots'
