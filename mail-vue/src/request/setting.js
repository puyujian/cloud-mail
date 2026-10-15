import http from '@/axios/index.js';

export function settingSet(setting) {
    return http.put('/setting/set', setting)
}

export function settingQuery() {
    return http.get('/setting/query')
}

export function websiteConfig() {
    return http.get('/setting/websiteConfig')
}

export function setBackground(background) {
    return http.put('/setting/setBackground',{background})
}

export function deleteBackground() {
    return http.delete('/setting/deleteBackground')
}

export function setBlackList(params) {
    return http.put('/setting/setBlacklist', params)
}

export function querySyncClipboard() {
    return http.get('/setting/querySyncClipboard')
}

export function setSyncClipboard(params) {
    return http.put('/setting/setSyncClipboard', params)
}

export function testSyncClipboard(params) {
    return http.put('/setting/testSyncClipboard', params)
}