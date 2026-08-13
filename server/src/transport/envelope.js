// 响应信封,逐字节对齐 index.js 的 ok/fail —— renderer 完全不变。
//   ok:   { success:true,  message, data, detail:{} }
//   fail: { success:false, code, message, data:null }
export const okBody = (data = null, message = '操作成功') => ({ success: true, message, data, detail: {} });
export const failBody = (message = '操作失败', code = 400) => ({ success: false, code, message, data: null });
