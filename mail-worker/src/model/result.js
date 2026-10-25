const result = {
	ok(data) {
		return { code: 200, message: 'success', data: data ? data : null };
	},
	fail(message, code = 500, errorKey) {
		// errorKey 仅在显式给出时附加，避免改变既有响应的形状
		if (errorKey) {
			return { code, message, errorKey };
		}
		return { code, message };
	}
};
export default result;
