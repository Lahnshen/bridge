<script lang="ts" module>
  // The terms of use: what the app is, that it comes as is, and that its users bear the risk of using it.
  export const SOURCE_URL = 'https://github.com/Lahnshen/bridge'
</script>

<article class="text-[13px] leading-relaxed">
  <h1 class="font-serif text-2xl leading-tight tracking-tight">Terms of Use</h1>
  <p class="text-muted-foreground mt-1 text-xs">Last updated November 4, 2026</p>

  <p class="bg-muted/60 mt-5 rounded-md px-3 py-2.5 text-xs">
    In short: Lahn Bridge is free software provided <strong>as is</strong>, with no warranty. It never holds your funds; you sign every transaction yourself, and
    you alone are responsible for them. Lahn is not liable for any loss, and the bridges and networks it uses are independent, under their own terms. If you
    don't accept these terms, don't use it.
  </p>

  <section>
    <h2>1. What Lahn Bridge is</h2>
    <p>
      Lahn Bridge (“the app”) is a free interface that helps you prepare transactions for third-party bridges and protocols (Circle CCTP, LI.FI, Skip Go,
      deBridge, Relay, Across, USDT0, LayerZero and others) and sign them with your own wallet. The app is not a bridge, exchange, custodian, broker or
      financial institution. It never takes custody of your tokens or your keys. Its source code is public at
      <a href={SOURCE_URL} target="_blank" rel="noreferrer">github.com/Lahnshen/bridge</a>.
    </p>
  </section>

  <section>
    <h2>2. Provided as is</h2>
    <p>
      The app, its code, its server and everything they show (routes, quotes, fees, timings, balances, statuses and any other information) are provided
      “as is” and “as available”, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose,
      accuracy, reliability, availability and non-infringement. Quotes and estimates come from third parties and may be wrong, change or fail. The app may
      be changed, limited, interrupted or shut down at any time without notice.
    </p>
  </section>

  <section>
    <h2>3. You are responsible</h2>
    <p>
      You decide on and make every transaction yourself, and you are solely responsible for it. That includes checking the networks, tokens, amounts,
      recipient addresses, fees and every transaction your wallet asks you to sign, and keeping your wallet, keys and devices secure. Blockchain
      transactions are irreversible: tokens sent to a wrong address or network, or lost in a failed transfer, may never be recovered.
    </p>
  </section>

  <section>
    <h2>4. Risks</h2>
    <p>Bridging and using blockchains carry serious risks, up to the total loss of your tokens, including:</p>
    <ul>
      <li>bugs, exploits or upgrades in smart contracts, bridges, wallets and the app itself;</li>
      <li>failures, delays, pauses or censorship by bridges, relayers, attesters, RPC providers, indexers and networks;</li>
      <li>price moves, slippage, fees and tokens losing their peg or value;</li>
      <li>wrong, stale or incomplete information from the app or third parties;</li>
      <li>
        <strong>a compromise of this website, its server, its code or anything it depends on</strong>, which could show you false information or ask you to
        sign a malicious transaction. Always check that you are on the site you expect and what your wallet shows before you sign;
      </li>
      <li>phishing, impersonation, and legal or regulatory action affecting any of the above.</li>
    </ul>
  </section>

  <section>
    <h2>5. No liability</h2>
    <p>
      To the fullest extent permitted by law, Lahn, who makes and runs the app, is not liable for any loss or damage of any kind, whether direct,
      indirect, incidental, special, consequential or punitive, including lost tokens, funds, profits or data, that arises from or relates to your use of or
      inability to use the app. This covers any transaction made with it, any third-party service, any error, delay or outage, and any compromise of the
      website, its server, its code or its dependencies, however caused and on any theory of liability, even if Lahn was told such loss was possible.
      Where liability can't be excluded, it is limited to what you paid to use the app, which is nothing.
    </p>
  </section>

  <section>
    <h2>6. Third parties</h2>
    <p>
      Transfers are carried out by independent third parties under their own terms, fees and policies. Lahn does not control, endorse or guarantee them,
      and is not responsible for what they do. Lahn Bridge is an independent project: it is not affiliated with, endorsed by or operated by Injective Labs,
      the Injective Foundation, Circle or any bridge it uses. Names and logos belong to their owners.
    </p>
  </section>

  <section>
    <h2>7. No advice</h2>
    <p>Nothing in the app is financial, investment, legal or tax advice. Do your own research.</p>
  </section>

  <section>
    <h2>8. Your obligations</h2>
    <p>
      You must use the app lawfully and comply with the laws that apply to you, including sanctions and tax laws. Don't use it if you are a sanctioned
      person, are in a sanctioned or restricted jurisdiction, or are not allowed to use such services where you live. You agree to indemnify and hold
      Lahn harmless from any claim, loss or cost arising from your use of the app or your breach of these terms.
    </p>
  </section>

  <section>
    <h2>9. Changes</h2>
    <p>
      These terms may change at any time. The date above shows the latest version, and using the app after a change means you accept it. If any part of
      these terms is held unenforceable, the rest still applies.
    </p>
  </section>

  <p class="text-muted-foreground mt-6 text-xs">By using Lahn Bridge you confirm that you have read, understood and accepted these terms.</p>
</article>

<style>
  section {
    margin-top: 1.25rem;
  }
  h2 {
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-bottom: 0.25rem;
  }
  p,
  li {
    color: color-mix(in oklch, var(--foreground), var(--muted-foreground) 35%);
  }
  ul {
    list-style: disc;
    margin-top: 0.375rem;
    padding-left: 1.125rem;
    display: grid;
    gap: 0.25rem;
  }
  a {
    color: var(--foreground);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
