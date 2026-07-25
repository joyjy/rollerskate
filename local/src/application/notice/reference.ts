export function noticeIdForDelivery(deliveryId: string): string {
  if (!/^del_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(deliveryId)) {
    throw new Error(`deliveryId must be a del_ UUIDv7: ${deliveryId}`);
  }
  return `ntc1_${deliveryId}`;
}

export function noticeConsoleRoute(noticeId: string): string {
  return `/console/runtime?noticeId=${encodeURIComponent(noticeId)}`;
}
