import {
  ProgressCallback,
  Protocol,
  ProtocolOptions,
} from "../shared/protocol.js";
import { Transport } from "../shared/transport.js";
import {
  CallToolRequest,
  CallToolResultSchema,
  ClientCapabilities,
  ClientNotification,
  ClientRequest,
  ClientResult,
  CompatibilityCallToolResultSchema,
  CompleteRequest,
  CompleteResultSchema,
  EmptyResultSchema,
  GetPromptRequest,
  GetPromptResultSchema,
  Implementation,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  ListPromptsRequest,
  ListPromptsResultSchema,
  ListResourcesRequest,
  ListResourcesResultSchema,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResultSchema,
  ListToolsRequest,
  ListToolsResultSchema,
  LoggingLevel,
  Notification,
  ReadResourceRequest,
  ReadResourceResultSchema,
  Request,
  Result,
  ServerCapabilities,
  SubscribeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  UnsubscribeRequest,
} from "../types.js";

export type ClientOptions = ProtocolOptions & {
  /**
   * Capabilities to advertise as being supported by this client.
   */
  capabilities: ClientCapabilities;
};

/**
 * An MCP client on top of a pluggable transport.
 *
 * The client will automatically begin the initialization flow with the server when connect() is called.
 *
 * To use with custom types, extend the base Request/Notification/Result types and pass them as type parameters:
 *
 * ```typescript
 * // Custom schemas
 * const CustomRequestSchema = RequestSchema.extend({...})
 * const CustomNotificationSchema = NotificationSchema.extend({...})
 * const CustomResultSchema = ResultSchema.extend({...})
 *
 * // Type aliases
 * type CustomRequest = z.infer<typeof CustomRequestSchema>
 * type CustomNotification = z.infer<typeof CustomNotificationSchema>
 * type CustomResult = z.infer<typeof CustomResultSchema>
 *
 * // Create typed client
 * const client = new Client<CustomRequest, CustomNotification, CustomResult>({
 *   name: "CustomClient",
 *   version: "1.0.0"
 * })
 * ```
 */
export class Client<
  RequestT extends Request = Request,
  NotificationT extends Notification = Notification,
  ResultT extends Result = Result,
> extends Protocol<
  ClientRequest | RequestT,
  ClientNotification | NotificationT,
  ClientResult | ResultT
> {
  private _serverCapabilities?: ServerCapabilities;
  private _serverVersion?: Implementation;
  private _capabilities: ClientCapabilities;

  /**
   * Initializes this client with the given name and version information.
   */
  constructor(
    private _clientInfo: Implementation,
    options: ClientOptions,
  ) {
    super(options);
    this._capabilities = options.capabilities;
  }

  protected assertCapability(
    capability: keyof ServerCapabilities,
    method: string,
  ): void {
    if (!this._serverCapabilities?.[capability]) {
      throw new Error(
        `Server does not support ${capability} (required for ${method})`,
      );
    }
  }

  override async connect(transport: Transport): Promise<void> {
    await super.connect(transport);

    try {
      const result = await this.request(
        {
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: this._capabilities,
            clientInfo: this._clientInfo,
          },
        },
        InitializeResultSchema,
      );

      if (result === undefined) {
        throw new Error(`Server sent invalid initialize result: ${result}`);
      }

      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
        throw new Error(
          `Server's protocol version is not supported: ${result.protocolVersion}`,
        );
      }

      this._serverCapabilities = result.capabilities;
      this._serverVersion = result.serverInfo;

      await this.notification({
        method: "notifications/initialized",
      });
    } catch (error) {
      // Disconnect if initialization fails.
      void this.close();
      throw error;
    }
  }

  /**
   * After initialization has completed, this will be populated with the server's reported capabilities.
   */
  getServerCapabilities(): ServerCapabilities | undefined {
    return this._serverCapabilities;
  }

  /**
   * After initialization has completed, this will be populated with information about the server's name and version.
   */
  getServerVersion(): Implementation | undefined {
    return this._serverVersion;
  }

  protected assertCapabilityForMethod(method: RequestT["method"]): void {
    switch (method as ClientRequest["method"]) {
      case "logging/setLevel":
        if (!this._serverCapabilities?.logging) {
          throw new Error(
            "Server does not support logging (required for logging/setLevel)",
          );
        }
        break;

      case "prompts/get":
      case "prompts/list":
        if (!this._serverCapabilities?.prompts) {
          throw new Error(
            `Server does not support prompts (required for ${method})`,
          );
        }
        break;

      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
      case "resources/subscribe":
      case "resources/unsubscribe":
        if (!this._serverCapabilities?.resources) {
          throw new Error(
            `Server does not support resources (required for ${method})`,
          );
        }

        if (
          method === "resources/subscribe" &&
          !this._serverCapabilities.resources.subscribe
        ) {
          throw new Error("Server does not support resource subscriptions");
        }

        break;

      case "tools/call":
      case "tools/list":
        if (!this._serverCapabilities?.tools) {
          throw new Error(
            `Server does not support tools (required for ${method})`,
          );
        }
        break;

      case "completion/complete":
        if (!this._serverCapabilities?.prompts) {
          throw new Error(
            "Server does not support prompts (required for completion/complete)",
          );
        }
        break;

      case "initialize":
        // No specific capability required for initialize
        break;

      case "ping":
        // No specific capability required for ping
        break;
    }
  }

  protected assertNotificationCapability(
    method: NotificationT["method"],
  ): void {
    switch (method as ClientNotification["method"]) {
      case "notifications/roots/list_changed":
        if (!this._capabilities.roots?.listChanged) {
          throw new Error(
            "Client does not support roots list changed notifications",
          );
        }
        break;

      case "notifications/initialized":
        // No specific capability required for initialized
        break;

      case "notifications/progress":
        // Progress notifications are always allowed
        break;
    }
  }

  protected assertRequestHandlerCapability(method: string): void {
    switch (method) {
      case "sampling/createMessage":
        if (!this._capabilities.sampling) {
          throw new Error("Client does not support sampling capability");
        }
        break;

      case "roots/list":
        if (!this._capabilities.roots) {
          throw new Error("Client does not support roots capability");
        }
        break;

      case "ping":
        // No specific capability required for ping
        break;
    }
  }

  async ping() {
    return this.request({ method: "ping" }, EmptyResultSchema);
  }

  async complete(
    params: CompleteRequest["params"],
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "completion/complete", params },
      CompleteResultSchema,
      onprogress,
    );
  }

  async setLoggingLevel(level: LoggingLevel) {
    return this.request(
      { method: "logging/setLevel", params: { level } },
      EmptyResultSchema,
    );
  }

  async getPrompt(
    params: GetPromptRequest["params"],
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "prompts/get", params },
      GetPromptResultSchema,
      onprogress,
    );
  }

  async listPrompts(
    params?: ListPromptsRequest["params"],
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "prompts/list", params },
      ListPromptsResultSchema,
      onprogress,
    );
  }

  async listResources(
    params?: ListResourcesRequest["params"],
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "resources/list", params },
      ListResourcesResultSchema,
      onprogress,
    );
  }

  async listResourceTemplates(
    params?: ListResourceTemplatesRequest["params"],
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "resources/templates/list", params },
      ListResourceTemplatesResultSchema,
      onprogress,
    );
  }

  async readResource(
    params: ReadResourceRequest["params"],
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "resources/read", params },
      ReadResourceResultSchema,
      onprogress,
    );
  }

  async subscribeResource(params: SubscribeRequest["params"]) {
    return this.request(
      { method: "resources/subscribe", params },
      EmptyResultSchema,
    );
  }

  async unsubscribeResource(params: UnsubscribeRequest["params"]) {
    return this.request(
      { method: "resources/unsubscribe", params },
      EmptyResultSchema,
    );
  }

  async callTool(
    params: CallToolRequest["params"],
    resultSchema:
      | typeof CallToolResultSchema
      | typeof CompatibilityCallToolResultSchema = CallToolResultSchema,
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "tools/call", params },
      resultSchema,
      onprogress,
    );
  }

  async listTools(
    params?: ListToolsRequest["params"],
    onprogress?: ProgressCallback,
  ) {
    return this.request(
      { method: "tools/list", params },
      ListToolsResultSchema,
      onprogress,
    );
  }

  async sendRootsListChanged() {
    return this.notification({ method: "notifications/roots/list_changed" });
  }
}
