class BizError extends Error {
	// errorKey 是可选的稳定标识：前端只拿到 code/message，光靠 HTTP 码
	// 分不清「额度用尽」和「操作过快」，都会显示成同一句提示
	constructor(message, code, errorKey) {
		super(message);
		this.code = code ? code : 501;
		this.name = 'BizError';
		if (errorKey) {
			this.errorKey = errorKey;
		}
	}
}

export default BizError;
