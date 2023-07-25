const { defineConfig } = require('@vue/cli-service')
module.exports = defineConfig({
    transpileDependencies: true,
    publicPath: '/',
    lintOnSave: false,
    devServer: {
        host: "0.0.0.0",
        port: 9099, // 端口号
    }
});