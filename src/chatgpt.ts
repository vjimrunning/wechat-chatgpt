import { ChatGPTAPI, ChatGPTConversation } from "chatgpt";
import { Message } from "wechaty";
import { MessageType } from "wechaty-puppet/src/schemas/message";
import { config } from "./config.js";
import { execa } from "execa";
import { Cache } from "./cache.js";
import { ContactInterface, RoomInterface } from "wechaty/impls";
import {
  IChatGPTItem,
  IConversationItem,
  AccountWithUserInfo,
  isAccountWithUserInfo,
  isAccountWithSessionToken,
} from "./interface.js";
const SINGLE_MESSAGE_MAX_SIZE = 500;
const ErrorCode2Message: Record<string, string> = {
  "503":
    "OpenAI 服务器繁忙，请稍后再试| The OpenAI server is busy, please try again later",
  "429":
    "OpenAI 服务器限流，请稍后再试| The OpenAI server was limted, please try again later",
  "500":
    "OpenAI 服务器繁忙，请稍后再试| The OpenAI server is busy, please try again later",
  unknown: "未知错误，请看日志 | Error unknown, please see the log",
};
export class ChatGPTPoole {
  chatGPTPools: Array<IChatGPTItem> | [] = [];
  conversationsPool: Map<string, IConversationItem> = new Map();
  cache = new Cache("cache.json");
  async getSessionToken(email: string, password: string): Promise<string> {
    if (this.cache.get(email)) {
      return this.cache.get(email);
    }
    const cmd = `poetry run python3 src/generate_session.py ${email} ${password}`;
    const platform = process.platform;
    const { stdout, stderr, exitCode } = await execa(
      platform === "win32" ? "powershell" : "sh",
      [platform === "win32" ? "/c" : "-c", cmd]
    );
    if (exitCode !== 0) {
      console.error(stderr);
      return "";
    }
    // The last line in stdout is the session token
    const lines = stdout.split("\n");
    if (lines.length > 0) {
      this.cache.set(email, lines[lines.length - 1]);
      return lines[lines.length - 1];
    }
    return "";
  }
  async startPools() {
    const sessionAccounts = config.chatGPTAccountPool.filter(
      isAccountWithSessionToken
    );
    const userAccounts = await Promise.all(
      config.chatGPTAccountPool
        .filter(isAccountWithUserInfo)
        .map(async (account: AccountWithUserInfo) => {
          const session_token = await this.getSessionToken(
            account.email,
            account.password
          );
          return {
            ...account,
            session_token,
          };
        })
    );
    this.chatGPTPools = [...sessionAccounts, ...userAccounts].map((account) => {
      return {
        chatGpt: new ChatGPTAPI({
          sessionToken: account.session_token,
        }),
        account,
      };
    });
    console.log(`ChatGPTPools: ${this.chatGPTPools.length}`);
  }
  // Randome get chatgpt item form pool
  get chatGPTAPI(): IChatGPTItem {
    return this.chatGPTPools[
      Math.floor(Math.random() * this.chatGPTPools.length)
    ];
  }
  // Randome get conversation item form pool
  getConversation(talkid: string): IConversationItem {
    if (this.conversationsPool.has(talkid)) {
      return this.conversationsPool.get(talkid) as IConversationItem;
    }
    const chatGPT = this.chatGPTAPI;
    const conversation = chatGPT.chatGpt.getConversation();
    const conversationItem = {
      conversation,
      account: chatGPT.account,
    };
    this.conversationsPool.set(talkid, conversationItem);
    return conversationItem;
  }
  // send message with talkid
  async sendMessage(message: string, talkid: string) {
    const conversationItem = this.getConversation(talkid);
    const { conversation, account } = conversationItem;
    try {
      // TODO: Add Retry logic
      const response = await conversation.sendMessage(message);
      return response;
    } catch (err: any) {
      console.error(
        `err is ${err.message}, account ${JSON.stringify(account)}`
      );
      // If send message failed, we will remove the conversation from pool
      this.conversationsPool.delete(talkid);
      // Retry
      return this.error2msg(err);
    }
  }
  // Make error code to more human readable message.
  error2msg(err: Error): string {
    for (const code in Object.keys(ErrorCode2Message)) {
      if (err.message.includes(code)) {
        return ErrorCode2Message[code];
      }
    }
    return ErrorCode2Message.unknown;
  }
}
export class ChatGPTBot {
  // Record talkid with conversation id
  conversations = new Map<string, ChatGPTConversation>();
  chatGPTPool = new ChatGPTPoole();
  cache = new Cache("cache.json");
  chatPrivateTiggerKeyword = config.chatPrivateTiggerKeyword;
  botName: string = "";
  setBotName(botName: string) {
    this.botName = botName;
  }
  get chatGroupTiggerKeyword(): string {
    return `@${this.botName}`;
  }
  async startGPTBot() {
    console.debug(`Start GPT Bot Config is:${config}`);
    await this.chatGPTPool.startPools();
    console.debug(`🤖️ Start GPT Bot Success, ready to handle message!`);
  }
  // TODO: Add reset conversation id and ping pong
  async command(): Promise<void> {}
  // remove more times conversation and mention
  cleanMessage(rawText: string, privateChat: boolean = false): string {
    let text = rawText;
    const item = rawText.split("- - - - - - - - - - - - - - -");
    if (item.length > 1) {
      text = item[item.length - 1];
    }
    text = text.replace(
      privateChat ? this.chatPrivateTiggerKeyword : this.chatGroupTiggerKeyword,
      ""
    );
    // remove more text via - - - - - - - - - - - - - - -
    return text;
  }
  async getGPTMessage(text: string, talkerId: string): Promise<string> {
    return await this.chatGPTPool.sendMessage(text, talkerId);
  }
  // The message is segmented according to its size
  async trySay(
    talker: RoomInterface | ContactInterface,
    mesasge: string
  ): Promise<void> {
    const messages: Array<string> = [];
    let message = mesasge;
    while (message.length > SINGLE_MESSAGE_MAX_SIZE) {
      messages.push(message.slice(0, SINGLE_MESSAGE_MAX_SIZE));
      message = message.slice(SINGLE_MESSAGE_MAX_SIZE);
    }
    messages.push(message);
    for (const msg of messages) {
      await talker.say(msg);
    }
  }
  // Check whether the ChatGPT processing can be triggered
  tiggerGPTMessage(text: string, privateChat: boolean = false): boolean {
    const chatPrivateTiggerKeyword = this.chatPrivateTiggerKeyword;
    let triggered = false;
    if (privateChat) {
      triggered = chatPrivateTiggerKeyword
        ? text.includes(chatPrivateTiggerKeyword)
        : true;
    } else {
      triggered = text.includes(this.chatGroupTiggerKeyword);
    }
    if (triggered) {
      console.log(`🎯 Triggered ChatGPT: ${text}`);
    }
    return triggered;
  }
  // Filter out the message that does not need to be processed
  isNonsense(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean {
    return (
      talker.self() ||
      messageType > 10 ||
      talker.name() == "微信团队" ||
      // 语音(视频)消息
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      // 红包消息
      text.includes("收到红包，请在手机上查看") ||
      // 位置消息
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg")
    );
  }

  async onPrivateMessage(talker: ContactInterface, text: string) {
    const talkerId = talker.id;
    const gptMessage = await this.getGPTMessage(text, talkerId);
    await this.trySay(talker, gptMessage);
  }

  async onGroupMessage(
    talker: ContactInterface,
    text: string,
    room: RoomInterface
  ) {
    const talkerId = talker.id;
    const gptMessage = await this.getGPTMessage(text, talkerId);
    const result = `${text}\n ------\n ${gptMessage}`;
    await this.trySay(room, result);
  }
  async onMessage(message: Message) {
    const talker = message.talker();
    const rawText = message.text();
    const room = message.room();
    const messageType = message.type();
    const privateChat = !room;
    if (this.isNonsense(talker, messageType, rawText)) {
      return;
    }
    if (this.tiggerGPTMessage(rawText, privateChat)) {
      const text = this.cleanMessage(rawText, privateChat);
      if (privateChat) {
        return await this.onPrivateMessage(talker, text);
      } else {
        return await this.onGroupMessage(talker, text, room);
      }
    } else {
      return;
    }
  }
}
