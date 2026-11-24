/** Use the carrier's authenticated peer. Older carriers authenticate in the route. */
export function admitHostRequest(ctx, request, peer) {
  return peer ? { peer } : ctx.connection.admit(request)
}
