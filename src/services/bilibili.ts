import { WbiUtils } from '../utils/wbi';

export interface VideoPart {
  bvid: string;
  cid: string;
  page: number;
  duration: number;
  title: string;
}

interface VideoInfo {
  title: string;
  desc?: string;
  owner: { mid: number };
  pages: { page: number; cid: number; duration: number; part: string }[];
}

export class BilibiliService {
  private static async fetchWithCookie(url: string, params: Record<string, any> = {}) {
    const queryString = new URLSearchParams(params).toString();
    const fullUrl = `${url}?${queryString}`;
    console.log('【VideoAdGuard】[BilibiliService] Fetching URL:', fullUrl);

    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/'
      },
      credentials: 'include'
    });

    const data = await response.json();
    if (data.code !== 0) {
      console.log('【VideoAdGuard】[BilibiliService] Error:', data.message);
      throw new Error(data.message);
    }
    return data.data;
  }

  public static async getVideoInfo(bvid: string): Promise<VideoInfo> {
    console.log('【VideoAdGuard】[BilibiliService] Getting video info');
    const data = await this.fetchWithCookie(
      'https://api.bilibili.com/x/web-interface/view',
      { bvid: bvid }
    );
    console.log('【VideoAdGuard】[BilibiliService] Video info result:', data);
    return data;
  }

  /** 详情最外层的 cid 属于 P1，当前 P 必须从 pages 匹配。 */
  public static resolveVideoPart(bvid: string, page: number, video: VideoInfo): VideoPart {
    const part = video.pages.find(item => item.page === page);
    if (!part || !Number.isSafeInteger(part.cid) || part.cid <= 0) {
      throw new Error(`未找到 ${bvid} 的 P${page}`);
    }
    const title = video.pages.length > 1 && part.part && part.part !== video.title
      ? `${video.title} - ${part.part}`
      : video.title;
    return { bvid, page, cid: String(part.cid), duration: part.duration, title };
  }

  public static async getComments(bvid: string) {
    console.log('【VideoAdGuard】[BilibiliService] Getting comments');
    const data = await this.fetchWithCookie(
      'https://api.bilibili.com/x/v2/reply',
      { oid: bvid, type: 1 }
    );
    console.log('【VideoAdGuard】[BilibiliService] Comments result:', data);
    return data;
  }

  public static async getTopComments(bvid: string) {
    console.log('【VideoAdGuard】[BilibiliService] Getting top comments');
    try {
      const data = await this.fetchWithCookie(
        'https://api.bilibili.com/x/v2/reply',
        { oid: bvid, type: 1}
      );
      const top_replies = data?.top_replies || null;
      const topComment = top_replies ? (top_replies[0]?.content || null) : null;
      console.log('【VideoAdGuard】[BilibiliService] Top comments result:', topComment);
      return topComment;
    } catch (error) {
      console.warn('【VideoAdGuard】[BilibiliService] Failed to get top comments:', error);
      return null;
    }
  }

  public static async getPlayerInfo(bvid: string, cid: string) {
    console.log('【VideoAdGuard】[BilibiliService] Getting player info');
    const params = { bvid: bvid, cid: cid};
    const signedParams = await WbiUtils.encWbi(params);
    const data = await this.fetchWithCookie(
      'https://api.bilibili.com/x/player/wbi/v2',
      signedParams
    );
    console.log('【VideoAdGuard】[BilibiliService] Player info result:', data);
    return data;
  }

  public static async getCaptions(url: string) {
    console.log('【VideoAdGuard】[BilibiliService] Getting captions from URL:', url);
    const response = await fetch(url);
    const data = await response.json();
    console.log('【VideoAdGuard】[BilibiliService] Captions result:', data);
    return data;
  }

  /**
   * 获取UP主信息
   * @param uid UP主的UID
   * @returns UP主信息，包含uid和name
   */
  public static async getUpInfo(uid: string) {
    console.log('【VideoAdGuard】[BilibiliService] Getting UP info');
    const params = { mid: uid };
    const signedParams = await WbiUtils.encWbi(params);
    const data = await this.fetchWithCookie(
      'https://api.bilibili.com/x/space/wbi/acc/info',
      signedParams
    );
    console.log('【VideoAdGuard】[BilibiliService] UP info result:', data);
    return {
      uid: data.mid.toString(),
      name: data.name
    };
  }

  /**
   * 获取视频流信息
   * @param bvid 视频的BVID
   * @param cid 视频的CID
   * @returns 视频流信息，包含播放地址等
   */
  public static async getPlayUrl(bvid: string, cid: string) {
    console.log('【VideoAdGuard】[BilibiliService] Getting video url');
    const params = { bvid: bvid, cid: cid, fnval: 16 };
    const signedParams = await WbiUtils.encWbi(params);
    const data = await this.fetchWithCookie(
      'https://api.bilibili.com/x/player/wbi/playurl',
      signedParams
    );
    console.log('【VideoAdGuard】[BilibiliService] video url result:', data);
    return data;
  }

  /**
   * AV号转BV号的本地算法实现
   * @param avid AV号（可以是数字字符串或带av前缀的字符串）
   * @returns BV号字符串
   */
  public static convertAvToBv(avid: string): string {
    // 算法常量
    const table = [...'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'];
    const base = BigInt(table.length);
    const rangeLeft = 1n;
    const rangeRight = 2n ** 51n;
    const xor = 23442827791579n;

    let num = avid;

    // 处理字符串输入，移除av前缀
    if (typeof num === 'string') {
      num = num.replace(/^[Aa][Vv]/u, '');
    }

    // 转换为bigint
    let numBigInt: bigint;
    try {
      numBigInt = BigInt(num);
    } catch (error) {
      throw new Error(`Invalid AV number: ${avid}`);
    }

    // 验证输入类型和范围
    if (!Number.isInteger(Number(num)) && typeof numBigInt !== 'bigint') {
      throw new Error(`Invalid AV number: ${avid}`);
    }

    // 检查范围
    if (numBigInt < rangeLeft || numBigInt >= rangeRight) {
      throw new Error(`AV number out of range: ${avid}`);
    }

    // 执行转换算法
    numBigInt = (numBigInt + rangeRight) ^ xor;
    let result = [...'BV1000000000'];
    let i = 11;

    while (i > 2) {
      result[i] = table[Number(numBigInt % base)];
      numBigInt = numBigInt / base;
      i -= 1;
    }

    // 字符位置交换
    [result[3], result[9]] = [result[9], result[3]];
    [result[4], result[7]] = [result[7], result[4]];

    return result.join('');
  }
}
