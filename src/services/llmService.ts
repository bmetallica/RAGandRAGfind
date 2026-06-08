import { requestGeneration } from "./aiProviderClient";
import { getAiProviderConnection, getSummaryModelName } from "./aiProviderSettingsService";

export class LlmService {
  async generate(prompt: string, model?: string): Promise<string> {
    const connection = await getAiProviderConnection();
    const resolvedModel = model ?? (await getSummaryModelName());
    return requestGeneration(connection, prompt, resolvedModel);
  }
}
