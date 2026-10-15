const path = require('path')

module.exports = {
    target: 'node',
    entry: 'src/index.ts',
    devtool: 'nosources-source-map',
    context: __dirname,
    mode: 'development',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        libraryTarget: 'umd',
        devtoolModuleFilenameTemplate: 'tabby-mux:///[resource-path]',
    },
    resolve: {
        modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            { test: /\.ts$/, loader: 'ts-loader',
              options: { configFile: path.resolve(__dirname, 'tsconfig.json') } },
        ],
    },
    externals: [
        'fs', 'path', 'os', 'electron', '@electron/remote', 'ngx-toastr',
        /^rxjs/, /^@angular/, /^@ng-bootstrap/, /^tabby-/,
        // WARNING: '@ngx-translate/core' must NEVER be listed here nor imported.
        // It only resolves on the app.asar node_modules chain (builtin plugins),
        // not on the user plugin chain; a failing require here silently kills
        // this plugin AND every user plugin loaded after it.
    ],
}
