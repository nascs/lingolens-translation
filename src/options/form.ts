import { defaultsForProvider, validateTransport, type Provider } from "../shared/config";

export interface ProviderFields {
  baseUrl: string;
  model: string;
  allowInsecureHttp: boolean;
}

export interface TransportPermissionResult {
  granted: boolean;
  origin: string;
}

export type TransportPermissionRequester = (request: { origins: string[] }) => Promise<boolean>;

export function requestTransportPermission(
  settings: { baseUrl: string; allowInsecureHttp: boolean },
  requester: TransportPermissionRequester
): Promise<TransportPermissionResult> {
  const transport = validateTransport(settings.baseUrl, settings.allowInsecureHttp);
  return requester({ origins: [transport.permissionPattern] })
    .then((granted) => ({ granted, origin: transport.origin }));
}

export function applyProviderChange(fields: ProviderFields, provider: Provider): ProviderFields {
  const defaults = defaultsForProvider(provider);
  return {
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    allowInsecureHttp: provider === "custom" ? false : fields.allowInsecureHttp
  };
}

export function consentAfterBaseUrlChange(
  previousBaseUrl: string,
  nextBaseUrl: string,
  currentConsent: boolean
): boolean {
  return previousBaseUrl === nextBaseUrl ? currentConsent : false;
}

export function showsInsecureHttpRisk(baseUrl: string): boolean {
  try {
    return validateTransport(baseUrl, true).requiresInsecureHttpConsent;
  } catch {
    return false;
  }
}
