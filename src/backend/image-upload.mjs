import { createImageRepository, requireImageOwner } from './image-repository.mjs';
import { withTransaction } from './transactions.mjs';

// Router has already run Origin/session guards and P18's bounded multipart,
// metadata and pixel validation. No transaction is held during decoding.
export function createImageUploadHandler({ database }) {
  const images = createImageRepository({ database });
  return async context => {
    requireImageOwner(context.auth); // Fail closed before checking out a client.
    return withTransaction(database.pool, async client => {
      const image = await images.create(context.auth, context.body, { client });
      // Build the safe metadata response before COMMIT, so serialization failure
      // rolls back too. withTransaction returns only after COMMIT acknowledgement.
      return Response.json({ image }, { status: 201 });
    });
  };
}
