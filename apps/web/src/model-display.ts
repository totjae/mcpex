export function modelDisplayName(
  model: { providerId: string; modelId: string; label?: string },
  providers: Array<{ id: string; name: string }>,
): string {
  const provider = providers.find((item) => item.id === model.providerId);
  const providerName = provider
    ? providers.filter((item) => item.name === provider.name).length > 1
      ? `${provider.name} · ${provider.id}`
      : provider.name
    : '프로바이더 확인 필요';
  return `${model.label?.trim() || model.modelId} (${providerName})`;
}
