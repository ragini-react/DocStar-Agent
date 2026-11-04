// One way for the agent to ask viaSocket AI for a JSON answer: the operator's user, a model that honours
// json_schema, retries on 429/5xx. Sync delivery only; prompts tell the model not to open its own browser
// (that path answers only over the websocket), because our own Chrome and fetcher do the reading.
import { viasocket } from '../integrations/viasocket.js'

export const MODEL = { service: 'anthropic', model: 'claude-sonnet-5-5' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

export function createAi({ config }) {
  const ai = { send: params => viasocket.user(config.operatorUserId).ai.send(params) } // created on use
  return {
    /** A plain-text answer: the path on which viaSocket's web search reliably runs. */
    async text({ threadId, message, prompt }) {
      const r = await ai.send({ threadId: threadId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100), message, prompt, ...MODEL })
      return String(r.content ?? '')
    },

    async json({ threadId, message, prompt, schema, attempts = 3 }) {
      let lastError
      for (let i = 0; i < attempts; i++) {
        try {
          const r = await ai.send({
            threadId: threadId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100),
            message,
            prompt,
            ...MODEL,
            responseType: 'json_schema',
            jsonSchema: schema
          })
          if (r.content && typeof r.content === 'object') return r.content
          lastError = new Error(`AI answered without the JSON object (${r.finishReason})`)
        } catch (error) {
          lastError = error
          if (error.status && error.status < 429) throw error // a 4xx other than 429 will not get better
        }
        await sleep(3000 * (i + 1))
      }
      throw lastError
    }
  }
}

export { obj, str, int, bool, arr, oneOf } from './schema.js'
