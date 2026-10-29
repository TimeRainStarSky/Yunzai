import fetch from "node-fetch"

/** 用 Node 加载远程图片，绕过 Chromium 网络环境差异；其他资源保持原生加载。 */
export async function installImageProxy(
  page,
  { fetchImage = fetch, timeout = 10000, warn = () => {} } = {},
) {
  const controllers = new Set()
  let disposed = false
  const dispose = () => {
    disposed = true
    page.off("request", onRequest)
    page.off("close", dispose)
    for (const controller of controllers) controller.abort()
  }

  const handle = async request => {
    const url = request.url()
    if (!/^https?:\/\//i.test(url) || request.resourceType() !== "image") {
      await request.continue()
      return
    }

    const headers = { ...request.headers() }
    if (/\.(?:miyoushe|mihoyo)\.com$/i.test(new URL(url).hostname))
      headers.referer = "https://www.miyoushe.com/"

    let lastError
    for (let attempt = 0; attempt < 2 && !disposed; attempt++) {
      const controller = new AbortController()
      controllers.add(controller)
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetchImage(url, { headers, signal: controller.signal })
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(`HTTP ${response.status}`)
        }
        // 超时覆盖完整响应体读取，避免收到响应头后一直等待图片数据。
        const body = Buffer.from(await response.arrayBuffer())
        if (disposed) return
        await request.respond({
          status: response.status,
          contentType: response.headers.get("content-type") || "application/octet-stream",
          body,
        })
        return
      } catch (error) {
        lastError = error
      } finally {
        clearTimeout(timer)
        controllers.delete(controller)
      }
    }
    if (disposed) return
    warn(`[Puppeteer] 图片加载失败 ${url}: ${lastError?.message}`)
    // 明确结束失败请求，避免坏链接阻塞整页截图至导航超时。
    await request.abort()
  }

  const onRequest = request => {
    // 页面关闭与异步请求完成可能同时发生，不能让事件监听器抛出未处理异常。
    void handle(request).catch(error => {
      if (!disposed) warn(`[Puppeteer] 图片请求处理失败: ${error.message}`)
    })
  }
  await page.setRequestInterception(true)
  page.on("request", onRequest)
  page.on("close", dispose)
  return dispose
}
