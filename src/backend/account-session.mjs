import { toPublicUser } from './account-validation.mjs';
import { clearSessionCookie } from './sessions.mjs';

// Identity comes from the Origin/session guard, never from request parameters.
export function createMeHandler() {
  return async context => Response.json({ user: context.auth?.user ? toPublicUser(context.auth.user) : null });
}

export function createLogoutHandler({ sessions, config }) {
  return async context => {
    // Await the database acknowledgement before clearing the browser cookie.
    // No active session (including a repeated logout) still has the same 204.
    if (context.auth?.session) await sessions.revoke(context.auth.session.id);
    return new Response(null, { status: 204, headers: { 'Set-Cookie': clearSessionCookie(config) } });
  };
}
