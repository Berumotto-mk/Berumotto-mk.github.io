(function () {
  function ensureHeadingId(heading, index) {
    if (heading.id) return heading.id;

    var base = heading.textContent.trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w\u4e00-\u9fff-]/g, "")
      .replace(/^-+|-+$/g, "");

    heading.id = base || "heading-" + (index + 1);
    return heading.id;
  }

  function buildSideToc() {
    var content = document.getElementById("write");
    if (!content || document.querySelector(".note-side-toc")) return;

    var headings = Array.prototype.slice.call(
      content.querySelectorAll("h1, h2, h3, h4, h5, h6")
    ).filter(function (heading) {
      return heading.textContent.trim().length > 0;
    });

    if (headings.length < 2) return;

    var nav = document.createElement("nav");
    nav.className = "note-side-toc";
    nav.setAttribute("aria-label", "On this page");

    var title = document.createElement("div");
    title.className = "note-side-toc-title";
    title.textContent = "On this page";
    nav.appendChild(title);

    headings.forEach(function (heading, index) {
      var id = ensureHeadingId(heading, index);
      var link = document.createElement("a");
      link.href = "#" + encodeURIComponent(id);
      link.textContent = heading.textContent.trim();
      link.className = "toc-" + heading.tagName.toLowerCase();
      link.dataset.headingId = id;
      nav.appendChild(link);
    });

    document.body.appendChild(nav);

    var links = Array.prototype.slice.call(nav.querySelectorAll("a"));
    var activeLink = null;
    var ticking = false;

    function setActive(link) {
      if (!link || link === activeLink) return;

      if (activeLink) activeLink.classList.remove("is-active");
      link.classList.add("is-active");
      activeLink = link;

      var linkTop = link.offsetTop;
      var linkBottom = linkTop + link.offsetHeight;
      var visibleTop = nav.scrollTop;
      var visibleBottom = visibleTop + nav.clientHeight;

      if (linkTop < visibleTop || linkBottom > visibleBottom) {
        nav.scrollTo({
          top: linkTop - nav.clientHeight / 2 + link.offsetHeight / 2,
          behavior: "smooth"
        });
      }
    }

    function updateActiveLink() {
      ticking = false;

      var anchorLine = Math.max(80, window.innerHeight * 0.22);
      var current = headings[0];

      headings.forEach(function (heading) {
        if (heading.getBoundingClientRect().top <= anchorLine) {
          current = heading;
        }
      });

      var link = links.find(function (item) {
        return item.dataset.headingId === current.id;
      });

      setActive(link);
    }

    function requestUpdate() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateActiveLink);
    }

    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);
    updateActiveLink();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildSideToc);
  } else {
    buildSideToc();
  }
})();
