import { ApiError } from './http-errors.mjs';

// Router checks method first. Origin, then session, then body/record processing.
export function createAuthenticationGuard({ sessions, config }) {
  return async context => {
    if (['POST', 'PATCH', 'DELETE'].includes(context.method)
        && context.headers.get('origin') !== config.publicOrigin) throw new ApiError('ORIGIN_REJECTED');
    const auth = await sessions.resolve(context.headers);
    if (context.isPrivate && !auth) throw new ApiError('AUTH_REQUIRED');
    return auth;
  };
}
