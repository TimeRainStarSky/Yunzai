import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { installImageProxy } from "../lib/imageProxy.js"

function fixture(url = "https://upload-bbs.miyoushe.com/test.png", type = "image") {
  const page = new EventEmitter()
  page.setRequestInterception = async enabled => assert.equal(enabled, true)
  let finish
  const done = new Promise(resolve => (finish = resolve))
  const request = {
    url: () => url,
    resourceType: () => type,
    headers: () => ({ "user-agent": "test-agent" }),
    continue: async () => finish({ action: "continue" }),
    abort: async () => finish({ action: "abort" }),
    respond: async response => finish({ action: "respond", ...response }),
  }
  return { page, request, done }
}

test("remote image is fulfilled with bytes and Miyoushe referer", async () => {
  const { page, request, done } = fixture()
  const dispose = await installImageProxy(page, {
    fetchImage: async (url, { headers }) => {
      assert.equal(headers.referer, "https://www.miyoushe.com/")
      assert.equal(headers["user-agent"], "test-agent")
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
    },
  })
  page.emit("request", request)
  const result = await done
  assert.equal(result.action, "respond")
  assert.equal(result.contentType, "image/png")
  assert.deepEqual(result.body, Buffer.from([1, 2, 3]))
  dispose()
})

test("local images and remote scripts bypass Node fetching", async () => {
  for (const [url, type] of [
    ["file:///tmp/image.png", "image"],
    ["https://example.com/a.js", "script"],
  ]) {
    const { page, request, done } = fixture(url, type)
    const dispose = await installImageProxy(page, {
      fetchImage: async () => assert.fail("unexpected fetch"),
    })
    page.emit("request", request)
    assert.equal((await done).action, "continue")
    dispose()
  }
})

test("a failed response is retried once and QQ images are supported", async () => {
  const { page, request, done } = fixture("https://q.qlogo.cn/g?b=qq&s=100&nk=1")
  let calls = 0
  const dispose = await installImageProxy(page, {
    fetchImage: async () =>
      ++calls === 1 ? new Response("error", { status: 503 }) : new Response("image"),
  })
  page.emit("request", request)
  assert.equal((await done).action, "respond")
  assert.equal(calls, 2)
  dispose()
})

test("timeout includes stalled response bodies and releases the request", async () => {
  const { page, request, done } = fixture()
  let calls = 0
  const warnings = []
  const dispose = await installImageProxy(page, {
    timeout: 20,
    warn: message => warnings.push(message),
    fetchImage: async (url, { signal }) => {
      calls++
      return {
        ok: true,
        arrayBuffer: () =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
          }),
      }
    },
  })
  page.emit("request", request)
  assert.equal((await done).action, "abort")
  assert.equal(calls, 2)
  assert.equal(warnings.length, 1)
  dispose()
})

test("closing a page cancels pending downloads without retrying", async () => {
  const { page, request } = fixture()
  let calls = 0
  let signal
  const dispose = await installImageProxy(page, {
    fetchImage: async (url, options) => {
      calls++
      signal = options.signal
      return new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("closed"))),
      )
    },
  })
  page.emit("request", request)
  page.emit("close")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1)
  assert.equal(page.listenerCount("request"), 0)
  dispose()
})
