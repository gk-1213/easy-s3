# easy-s3
将AWS S3大文件文件上传相关的API集成为js文件，功能包括多文件并行上传、文件分片上传、断点续传、文件分片合成、上传暂停、取消上传、文件上传进度条显示。

暂时不包括文件分片下载相关功能，可后续迭代。

使用方法：下载s3.js文件并引入到需要使用的js文件中，即可使用
具体使用示例可参照下文中的第二点

### 一、API

#### 1、init

传入以下参数，初始化s3客户端

![image](https://github.com/gk-1213/easy-s3/assets/76909981/fd43ddef-b6e3-487e-8c13-199c82780e79)


#### 2、fileChange

加入文件上传任务，使用该方法

传入参数：

```javascript
fileChange({ fileList, bucket, changeStatus, getSuspend, changeSharding } )   //注意，传入的是一个map

/**
	fileList:文件信息数组,其内部元素的结构为
	{
		percentage: 0,//该文件的上传进度，如果不需要展示进度的话，可以不传 false
		status: 'wait',//文件上传的状态  true
		file: file,//需要上传的文件   true
		needSuspend: false,//是否暂停  true
		sharding: [],//分片数组，该文件已经上传了那些分片  true
		shardSize: 32 * 1024 * 1024//该文件每个分片的大小   true
	}
*/

/**
	bucket：文件上传到s3上的bucket名称
*/

/**
	changeStatus：一个事件，前端页面定义的可以改变文件上传的状态的事件
	示例：
	changeStatus(name, val) {//传入参数 name：文件名称   val：文件状态
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].file.name == name) {
                    this.fileList[i].status = val;
                    if (val === 'success') {
                        this.fileList[i].percentage = 100;
                    }
                    break;
                }
            }
        },

*/


/**
	getSuspend：一个事件，前端页面定义的可以获取该文件上传是否暂停的事件
	示例：
	getSuspend(name) {//传入参数 name : 该文件的名称
            let suspend = this.fileList.filter(e => {
                return e.file.name === name;
            });
            if (suspend.length != 0) {
                return suspend[0].needSuspend;
            }
            return false;
     },
*/
/**
	changeSharding：前端页面定义的可以改变该文件的已经上传分片的事件
	示例：
	changeSharding(name, shard) {//传入参数 name：文件的名称  shard：文件已经上传的分片
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].file.name === name) {
                    this.fileList[i].sharding = shard;
                    //改变进度条
                    let size = 0;
                    for (let j = 0; j < shard.length; j++) {
                        size += shard[j].Size;
                    }
                    //计算该文件的上传进度
                    this.fileList[i].percentage = ((size / this.fileList[i].file.size) * 100).toFixed(1) - 0;
                    return;
                }
            }
        },
*/
```



#### 3、cancel

取消一个文件的上传

```javascript
cancel({ bucket, file })//注意，传入的是一个map
/**
	bucket：文件上传到s3上的bucket名称
*/
/**
	file：取消的文件
*/
```

#### 4、getWorker

判断某个文件是否正在上传，或已经在上传任务中了

使用场景：对文件上传任务点击继续时，判断是否需要将该文件加入到上传任务队列中，因为对该文件的上传 短时间内频繁点击暂停、继续按钮时，可能会导致重复加入同一个文件的上传任务

（只有该任务终止，才应该加入上传队列）

（文件上传分片之前会判断该文件是否已经暂停上传，暂停的话，就会终止任务；或者文件分片上传出错的话，也会终止任务）

```javascript
getWorker(file)
/**
	file:文件
*/
返回值：false：没有正在上传   true：正在上传
```



### 二、封装的API使用示例

#### 

```javascript
<template>
    <div class="about">
        <div style="display: flex;justify-content: center;align-items: center;">
            <el-form label-position="left" label-width="120px" :model="s3Clent" style="width:500px">
                <el-form-item label="endpoint">
                    <el-input v-model="s3Clent.endpoint"></el-input>
                </el-form-item>
                <el-form-item label="region">
                    <el-input v-model="s3Clent.region"></el-input>
                </el-form-item>
                <el-form-item label="signatureVersion">
                    <el-input v-model="s3Clent.signatureVersion"></el-input>
                </el-form-item>
                <el-form-item label="accessKeyId">
                    <el-input v-model="s3Clent.credentials.accessKeyId"></el-input>
                </el-form-item>
                <el-form-item label="secretAccessKey">
                    <el-input v-model="s3Clent.credentials.secretAccessKey"></el-input>
                </el-form-item>
            </el-form>
        </div>
        <input multiple v-show="false" ref="fileRef" type="file" @change="inputFile">
        <el-button type="primary" @click="upload()">点击上传文件</el-button>

        <div v-for="f in fileList" :key="f.file.name">
            <div style="margin-top:50px;display: flex;align-items: center;justify-content: center;" v-if="f.show">
                <div style="margin-right:20px;font-size:15px;font-weight:60">
                    {{ f.file.name }}
                </div>
                <el-progress :percentage="f.percentage" style="width:500px"></el-progress>
                <div style="margin-left:20px">
                    <span v-if="f.status == 'err'" style="color:#F56C6C">上传错误</span>
                    <span v-else-if="f.status == 'same name'" style="color:#F56C6C">同名文件</span>
                    <span v-else-if="f.status == 'success'" style="color:#67C23A">上传成功</span>
                    <span v-else-if="f.status == 'suspend'" style="color:#409EFF">已暂停</span>
                </div>
                <div style="margin-left:20px">
                    <!-- 暂停按钮 -->
                    <el-button type="primary" icon="el-icon-video-pause" circle v-if="f.status === 'wait'"
                        @click="suspendButton(f)"></el-button>
                    <!-- 继续按钮 -->
                    <el-button type="primary" icon="el-icon-video-play" circle v-if="f.status === 'suspend'"
                        @click="continuedButton(f)"></el-button>
                    <!-- 取消按钮 -->
                    <el-button type="danger" icon="el-icon-close" circle v-if="f.status === 'suspend' || f.status === 'err'"
                        @click="cancelButton(f)"></el-button>
                    <!-- 重试按钮 -->
                    <el-button type="primary" icon="el-icon-refresh-right" circle v-if="f.status === 'err'"
                        @click="continuedButton(f)"></el-button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { init, cancel, fileChange, getWorker } from '../assets/js/s3.js'
export default {
    data() {
        return {
            fileList: [],//存储上传文件列表
            s3Clent: {
                endpoint: "http://minio.3wok.top",
                region: 'us-east-1',
                s3ForcePathStyle: true,
                signatureVersion: 'v4',
                forcePathStyle: true,

                credentials: {
                    accessKeyId: '0r7OhuS86vkBc7it',
                    secretAccessKey: '14DCVAwMX4FYhQno8OLRRyVKAbJkPfcY'
                },
            }//s3配置文件
        }
    },
    methods: {
        async continuedButton(file) {
            file.needSuspend = false;
            file.status = 'wait';
            const isInQueue = getWorker(file.file);
            console.log("isInQueue", isInQueue)
            if (isInQueue === false) {
                //如果任务队列中没有这个文件上传任务，那么就加入到任务队列中
                fileChange({ fileList: [file], bucket: 'test', changeStatus: this.changeStatus, getSuspend: this.getSuspend, changeSharding: this.changeSharding });
            }

        },
        async cancelButton(f) {
            await cancel({ bucket: 'test', file: f.file });
            this.fileList = this.fileList.filter(e => {
                return e.file.name !== f.file.name;
            });
        },
        upload() {
            this.$refs.fileRef.dispatchEvent(new MouseEvent('click'));
        },
        inputFile(event) {
            let files = event.target.files;
            let addFile = [];
            for (let i = 0; i < files.length; i++) {
                this.fileList.push({
                    percentage: 0,
                    status: 'wait',
                    show: true,
                    file: files[i],
                    needSuspend: false,
                    sharding: [],//分片数组
                    shardSize: 32 * 1024 * 1024//每个分片的大小
                });
                addFile.push({
                    percentage: 0,
                    status: 'wait',
                    show: true,
                    file: files[i],
                    needSuspend: false,
                    sharding: [],//分片数组
                    shardSize: 32 * 1024 * 1024//每个分片的大小
                });
            }
            fileChange({ fileList: addFile, bucket: 'test', changeStatus: this.changeStatus, getSuspend: this.getSuspend, changeSharding: this.changeSharding })
        },
        //暂停
        suspendButton(file) {
            file.needSuspend = true;
            file.status = 'suspend';
        },
        //修改状态
        changeStatus(name, val) {
            //TODO 改变进度条
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].file.name == name) {
                    this.fileList[i].status = val;
                    if (val === 'success') {
                        this.fileList[i].percentage = 100;
                    }
                    break;
                }
            }
        },
        //修改分片数组
        changeSharding(name, shard) {
            console.log(shard)
            for (let i = 0; i < this.fileList.length; i++) {
                if (this.fileList[i].file.name === name) {
                    this.fileList[i].sharding = shard;
                    //改变进度条
                    let size = 0;
                    for (let j = 0; j < shard.length; j++) {
                        size += shard[j].Size;
                    }
                    this.fileList[i].percentage = ((size / this.fileList[i].file.size) * 100).toFixed(1) - 0;
                    return;
                }
            }
        },
        //获取该文件是否需要暂停
        getSuspend(name) {
            let suspend = this.fileList.filter(e => {
                return e.file.name === name;
            });
            if (suspend.length != 0) {
                return suspend[0].needSuspend;
            }
            return false;
        },

    },
    created() {
        //创建客户端
        init(this.s3Clent);
    }
}
</script>
```

